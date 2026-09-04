local M = {}

--- The `helm` this plugin runs. `g:helm_cli` (a list) wins, then `$HELM_CLI`
--- (space-separated; `helm view` sets it to the bundle that is running), then
--- `helm` on PATH.
function M.command()
  if type(vim.g.helm_cli) == 'table' then
    return vim.deepcopy(vim.g.helm_cli)
  end
  local env = vim.env.HELM_CLI
  if env and env ~= '' then
    return vim.split(env, ' ', { trimempty = true })
  end
  return { 'helm' }
end

local function failure(res)
  local err = vim.trim(res.stderr or '')
  if err ~= '' then
    return err
  end
  return ('helm exited %d with nothing on stderr.'):format(res.code)
end

--- Runs `helm <args> --json` and decodes it. Returns `data, nil` or
--- `nil, sentence`; never raises, so a painter can show the sentence instead
--- of an empty buffer that looks like "nothing there".
function M.json(args)
  local cmd = M.command()
  vim.list_extend(cmd, args)
  table.insert(cmd, '--json')
  local ok, res = pcall(function()
    return vim.system(cmd, { text = true }):wait()
  end)
  if not ok then
    return nil, ('could not run %s: %s'):format(cmd[1], tostring(res))
  end
  if res.code ~= 0 then
    return nil, failure(res)
  end
  local decoded, data = pcall(vim.json.decode, res.stdout, { luanil = { object = true, array = true } })
  if not decoded then
    return nil, 'helm printed something that is not JSON: ' .. tostring(data)
  end
  return data, nil
end

--- Runs `helm <args>` synchronously for its exit code and its sentence.
function M.run(args)
  local cmd = M.command()
  vim.list_extend(cmd, args)
  local ok, res = pcall(function()
    return vim.system(cmd, { text = true }):wait()
  end)
  if not ok then
    return 127, ('could not run %s: %s'):format(cmd[1], tostring(res))
  end
  return res.code, res.code == 0 and vim.trim(res.stdout or '') or failure(res)
end

return M
