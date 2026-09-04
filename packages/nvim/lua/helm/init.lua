local cli = require 'helm.cli'
local buffers = require 'helm.buffers'

local M = {}

local ns = vim.api.nvim_create_namespace 'helm'

--- `helm://config//home/me` carries the scope directory after the prefix;
--- the other three carry nothing.
local function parse(uri)
  local kind, rest = uri:match '^helm://([%a]+)/?(.*)$'
  if kind == 'config' then
    return 'config', rest ~= '' and rest or nil
  end
  if kind == 'effective' or kind == 'profiles' or kind == 'history' then
    return kind, nil
  end
  return nil, nil
end

local function fetch(kind, arg)
  if kind == 'profiles' then
    return cli.json { 'profile', 'list' }
  elseif kind == 'history' then
    return cli.json { 'history' }
  elseif kind == 'config' then
    if not arg then
      return nil, 'helm://config needs a scope directory: helm://config/<dir>.'
    end
    return cli.json { 'config', 'tree', arg }
  elseif kind == 'effective' then
    local args = { 'config', 'doctor' }
    if vim.g.helm_profile and vim.g.helm_profile ~= '' then
      vim.list_extend(args, { '--profile', vim.g.helm_profile })
    end
    return cli.json(args)
  end
  return nil, ('%s is not a helm:// buffer.'):format(tostring(kind))
end

local function keymap(buf, lhs, fn, desc)
  vim.keymap.set('n', lhs, fn, { buffer = buf, nowait = true, silent = true, desc = desc })
end

local function open_target(buf)
  local targets = vim.b[buf].helm_targets or {}
  local path = targets[tostring(vim.api.nvim_win_get_cursor(0)[1])]
  if not path then
    vim.notify('No file on this line.', vim.log.levels.INFO)
    return
  end
  vim.cmd.edit(vim.fn.fnameescape(path))
end

local function close(buf)
  local others = vim.tbl_filter(function(b)
    return b ~= buf and vim.bo[b].buflisted and vim.api.nvim_buf_is_loaded(b)
  end, vim.api.nvim_list_bufs())
  if #others == 0 and #vim.api.nvim_list_wins() == 1 then
    vim.cmd.quit()
  else
    vim.cmd.bdelete { buf, bang = true }
  end
end

--- Paints `uri` into `buf`. The option order is the one measured to make `:q`
--- clean (TERMINAL.md 9): lines while modifiable, then modified=false,
--- modifiable=false, readonly.
function M.paint(buf, uri)
  local kind, arg = parse(uri)
  local data, err = fetch(kind, arg)
  local canvas
  if data then
    canvas = buffers[kind](data)
  else
    canvas = buffers.failure(uri, err)
  end

  local targets = {}
  for line, path in pairs(canvas.targets) do
    targets[tostring(line)] = path
  end

  local bo = vim.bo[buf]
  bo.buftype = 'nofile'
  bo.bufhidden = 'wipe'
  bo.swapfile = false
  bo.modifiable = true
  bo.readonly = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, canvas.lines)
  bo.modified = false
  bo.modifiable = false
  bo.readonly = true
  -- Not `helm`: that is a tree-sitter grammar (Helm charts), and a config with
  -- nvim-treesitter's auto-install started compiling it the first time a view
  -- opened (measured 2026-09-04).
  bo.filetype = 'helmview'
  vim.b[buf].helm_uri = uri
  vim.b[buf].helm_kind = kind
  vim.b[buf].helm_targets = targets

  keymap(buf, '<CR>', function()
    open_target(buf)
  end, 'helm: open the file under the cursor')
  keymap(buf, 'q', function()
    close(buf)
  end, 'helm: close')
  keymap(buf, '<leader>hr', function()
    M.paint(buf, uri)
  end, 'helm: repaint')

  if kind == 'history' or kind == 'effective' then
    M.watch()
  end
end

--- The BufReadCmd. `ev.match` is the buffer name as typed.
function M.open(buf, uri)
  M.paint(buf, uri)
end

function M.command(fargs)
  local what, arg = fargs[1], fargs[2]
  if what == 'config' then
    if not arg then
      vim.notify('Helm config needs a directory.', vim.log.levels.ERROR)
      return
    end
    vim.cmd.edit('helm://config/' .. vim.fn.fnamemodify(arg, ':p'):gsub('/$', ''))
  elseif what == 'effective' or what == 'profiles' or what == 'history' then
    vim.cmd.edit('helm://' .. what)
  else
    vim.notify(('Helm knows effective, profiles, history and config <dir> - not %s.'):format(tostring(what)), vim.log.levels.ERROR)
  end
end

-- Diagnostics ---------------------------------------------------------------

local severity = { error = vim.diagnostic.severity.ERROR, warning = vim.diagnostic.severity.WARN }

--- `helm profile check <file> --json` after a save under `.helm/profiles/`.
--- Problems become diagnostics on the line the CLI names, or line 1.
function M.check_profile(buf, file)
  local cmd = cli.command()
  vim.list_extend(cmd, { 'profile', 'check', file, '--json' })
  vim.system(cmd, { text = true }, function(res)
    vim.schedule(function()
      if not vim.api.nvim_buf_is_valid(buf) then
        return
      end
      if res.code ~= 0 then
        local ok, report = pcall(vim.json.decode, res.stdout or '')
        if not (ok and type(report) == 'table' and report.problems) then
          vim.notify('helm profile check: ' .. vim.trim(res.stderr ~= '' and res.stderr or 'exited ' .. res.code), vim.log.levels.WARN)
          return
        end
        res.report = report
      end
      local report = res.report or vim.json.decode(res.stdout)
      local diags = {}
      for _, p in ipairs(report.problems or {}) do
        diags[#diags + 1] = {
          lnum = math.max((p.line or 1) - 1, 0),
          col = 0,
          severity = severity[p.level] or vim.diagnostic.severity.ERROR,
          message = p.field and (p.field .. ': ' .. p.message) or p.message,
          source = 'helm',
        }
      end
      vim.diagnostic.set(ns, buf, diags)
    end)
  end)
end

-- Snapshot on write -----------------------------------------------------------

--- Synchronous by design: the write waits for the row. Returns the refusal
--- sentence, or nil when the row was taken; the autocommand in plugin/helm.lua
--- throws the sentence, which is what aborts the write.
function M.snapshot(file)
  local code, sentence = cli.run { 'config', 'snapshot', file }
  if code ~= 0 then
    return ('helm refused the write: %s'):format(sentence)
  end
  return nil
end

-- Liveness ---------------------------------------------------------------------

local watching = false

local function claude_home()
  local override = vim.env.CLAUDE_CONFIG_DIR
  if override and override ~= '' then
    return override
  end
  return vim.fs.joinpath(vim.uv.os_homedir(), '.claude')
end

local function data_dir()
  local override = vim.env.HELM_DATA_DIR
  if override and override ~= '' then
    return override
  end
  local xdg = vim.env.XDG_DATA_HOME
  if xdg and xdg ~= '' then
    return vim.fs.joinpath(xdg, 'helm')
  end
  return vim.fs.joinpath(vim.uv.os_homedir(), '.local', 'share', 'helm')
end

local function repaint_live()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      local kind = vim.b[buf].helm_kind
      if kind == 'history' or kind == 'effective' then
        M.paint(buf, vim.b[buf].helm_uri)
      end
    end
  end
end

--- One watcher each on `~/.claude/sessions` and the store's directory, started
--- the first time a live buffer is painted. A burst of events is one repaint,
--- 300ms after the last.
function M.watch()
  if watching then
    return
  end
  watching = true
  local timer = vim.uv.new_timer()
  local function bump()
    timer:stop()
    timer:start(300, 0, vim.schedule_wrap(repaint_live))
  end
  for _, dir in ipairs { vim.fs.joinpath(claude_home(), 'sessions'), data_dir() } do
    if vim.uv.fs_stat(dir) then
      local handle = vim.uv.new_fs_event()
      handle:start(dir, {}, bump)
    end
  end
end

return M
