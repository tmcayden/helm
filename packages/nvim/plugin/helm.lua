-- Eager on purpose (TERMINAL.md 11): the buffer named on nvim's command line is
-- read before any lazy handler would have run, so the BufReadCmd has to exist
-- by the time `nvim helm://effective` looks for one. Guarded because `helm
-- view` puts this directory on the runtime path even when the user's config
-- already has it.
if vim.g.loaded_helm then
  return
end
vim.g.loaded_helm = true

local group = vim.api.nvim_create_augroup('helm', { clear = true })

vim.api.nvim_create_autocmd('BufReadCmd', {
  group = group,
  pattern = 'helm://*',
  callback = function(ev)
    require('helm').open(ev.buf, ev.match)
  end,
})

vim.api.nvim_create_autocmd('BufWritePost', {
  group = group,
  pattern = { '*/.helm/profiles/*.yaml', '*/.helm/profiles/*.yml' },
  callback = function(ev)
    require('helm').check_profile(ev.buf, ev.match)
  end,
})

-- The write is refused when the snapshot could not be taken. This one is a
-- Vimscript command rather than a Lua callback, and that is load-bearing:
-- measured on NVIM v0.12.2, an error raised from a Lua callback is reported and
-- the write goes ahead, where a Vimscript `throw` out of BufWritePre aborts
-- it (TERMINAL.md 6, the config console's rule with the editor changed).
vim.api.nvim_create_autocmd('BufWritePre', {
  group = group,
  pattern = { '*/.claude/*', '*/.claude.json' },
  command = "let g:helm_refusal = v:lua.require('helm').snapshot(expand('<amatch>')) | if g:helm_refusal isnot v:null | throw g:helm_refusal | endif",
})

vim.api.nvim_create_user_command('Helm', function(opts)
  require('helm').command(opts.fargs)
end, {
  nargs = '+',
  complete = function()
    return { 'effective', 'profiles', 'history', 'config' }
  end,
  desc = 'Open a helm:// buffer: effective, profiles, history, config <dir>',
})
