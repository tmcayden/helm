--- Painters: each takes decoded `helm ... --json` and returns the lines to
--- draw plus, per line index, the file that line is about, so `<CR>` can open
--- it. Nothing here reads a file or a database - the CLI is the only source.
local M = {}

local function columns(rows)
  local widths = {}
  for _, row in ipairs(rows) do
    for i, cell in ipairs(row) do
      widths[i] = math.max(widths[i] or 0, vim.fn.strdisplaywidth(cell))
    end
  end
  local out = {}
  for _, row in ipairs(rows) do
    local cells = {}
    for i, cell in ipairs(row) do
      if i == #row then
        cells[i] = cell
      else
        cells[i] = cell .. string.rep(' ', widths[i] - vim.fn.strdisplaywidth(cell))
      end
    end
    out[#out + 1] = (table.concat(cells, '  '):gsub('%s+$', ''))
  end
  return out
end

local function s(value)
  if value == nil then
    return '-'
  end
  return tostring(value)
end

--- A painter's accumulator: `add(line, path)` records the file a line is about.
local function canvas()
  local c = { lines = {}, targets = {} }
  function c.add(line, path)
    c.lines[#c.lines + 1] = line
    if path then
      c.targets[#c.lines] = path
    end
  end
  function c.table(rows, paths)
    for i, line in ipairs(columns(rows)) do
      c.add(line, paths and paths[i] or nil)
    end
  end
  function c.blank()
    c.add('')
  end
  return c
end

function M.profiles(data)
  local c = canvas()
  c.add('helm profiles' .. '  (Enter opens the yaml, q closes, <leader>hr repaints)')
  c.blank()
  if #data == 0 then
    c.add('No profiles. A profile is <harness>/.helm/profiles/<name>.yaml.')
    return c
  end
  local rows, paths = { { 'NAME', 'HARNESS', 'MODEL/EFFORT', 'USES', 'PROBLEMS' } }, { false }
  for _, p in ipairs(data) do
    rows[#rows + 1] = { p.name, p.harness, s(p.model) .. '/' .. s(p.effort), s(p.uses), table.concat(p.problems or {}, ' ') }
    paths[#paths + 1] = p.file
  end
  c.table(rows, paths)
  return c
end

function M.history(data)
  local c = canvas()
  c.add('helm history  (newest first; RESUME marks a conversation helm resume can reopen)')
  c.blank()
  if #data == 0 then
    c.add('No sessions recorded yet.')
    return c
  end
  local rows = { { 'ID', 'STARTED', 'STATUS', 'EXIT', 'RESUME', 'NAME', 'CWD' } }
  for _, r in ipairs(data) do
    rows[#rows + 1] = {
      s(r.id),
      (r.startedAt or ''):sub(1, 16):gsub('T', ' '),
      s(r.status),
      r.exitCode == nil and '-' or tostring(r.exitCode),
      r.resumable and 'yes' or '-',
      s(r.name),
      s(r.cwd),
    }
  end
  c.table(rows)
  return c
end

function M.config(data)
  local c = canvas()
  local scope = data.scope
  local head = ('%s (%s)  %s'):format(scope.label, scope.kind, scope.claudeDir)
  if data.profile then
    head = head .. '  live against profile ' .. data.profile
  end
  c.add(head)
  c.blank()
  if not scope.exists then
    c.add(scope.claudeDir .. ' does not exist.')
    return c
  end
  if #data.files == 0 then
    c.add('Nothing in the tree.')
  else
    local rows, paths = { { 'KIND', 'NAME', 'STATE', 'NOTE', 'PATH' } }, { false }
    for _, f in ipairs(data.files) do
      local live = f.live or {}
      rows[#rows + 1] = { f.kind, f.name, live.state or '-', live.note or '', f.relPath }
      paths[#paths + 1] = f.path
    end
    c.table(rows, paths)
  end
  for _, err in ipairs(data.errors or {}) do
    c.add('warning: ' .. err)
  end
  return c
end

local function section(c, title, rows, paths, empty)
  c.add(title)
  if #rows == 0 then
    c.add('  ' .. empty)
  else
    for i, line in ipairs(columns(rows)) do
      c.add('  ' .. line, paths and paths[i] or nil)
    end
  end
  c.blank()
end

function M.effective(data)
  local c = canvas()
  local view, profile = data.view, data.profile
  c.add(('profile %s (%s)  %s'):format(profile.name, profile.resolvedBy, profile.file), profile.file)
  c.add('root ' .. view.cwd)
  c.blank()

  local rows, paths = {}, {}
  for _, o in ipairs(view.overlays) do
    local counts = o.exists and ('%d skills, %d commands, %d agents'):format(o.skills, o.commands, o.agents) or 'missing'
    rows[#rows + 1] = { o.name, counts, o.projectPath }
    paths[#paths + 1] = o.projectPath
  end
  section(c, 'overlays', rows, paths, 'none')

  for _, kind in ipairs { 'skills', 'commands', 'agents' } do
    rows, paths = {}, {}
    for _, e in ipairs(view[kind]) do
      rows[#rows + 1] = { e.invocation, e.source, e.path }
      paths[#paths + 1] = e.path
    end
    section(c, kind, rows, paths, 'none')
  end

  local settings, hooks, spaths, hpaths = {}, {}, {}, {}
  for _, st in ipairs(view.settings) do
    local row = { st.key, st.value, st.winner .. (st.overridden and ' (overrides)' or ''), st.winnerFile }
    if st.key:sub(1, 6) == 'hooks.' then
      hooks[#hooks + 1] = row
      hpaths[#hpaths + 1] = st.winnerFile
    else
      settings[#settings + 1] = row
      spaths[#spaths + 1] = st.winnerFile
    end
  end
  section(c, 'settings', settings, spaths, 'no settings leaves')
  section(c, 'hooks', hooks, hpaths, 'none')

  rows, paths = {}, {}
  for _, i in ipairs(view.instructions) do
    rows[#rows + 1] = { i.source, ('%d B'):format(i.bytes), i.path }
    paths[#paths + 1] = i.path
  end
  section(c, 'instructions', rows, paths, 'none')

  rows, paths = {}, {}
  for _, m in ipairs(view.mcpServers) do
    local approved = ''
    if m.approved == true then
      approved = 'approved'
    elseif m.approved == false then
      approved = 'unapproved'
    end
    rows[#rows + 1] = { m.name, m.scope, m.transport, approved, m.file }
    paths[#paths + 1] = m.file
  end
  section(c, 'mcp servers', rows, paths, 'none')

  c.add('argv')
  c.add('  claude ' .. table.concat(data.argv, ' '))
  if data.composesMemory then
    c.add("  plus --append-system-prompt-file <the overlays' CLAUDE.md, composed by the launch>")
  end
  for _, w in ipairs(view.warnings or {}) do
    c.add('warning: ' .. w)
  end
  return c
end

--- One line saying what went wrong. "Could not look" is painted, never an
--- empty buffer that reads as "nothing there".
function M.failure(uri, sentence)
  local c = canvas()
  c.add(uri .. ' could not be painted.')
  c.blank()
  for _, line in ipairs(vim.split(sentence, '\n', { trimempty = true })) do
    c.add(line)
  end
  c.blank()
  c.add('<leader>hr tries again; q closes.')
  return c
end

return M
