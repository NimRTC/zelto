" zelto-slice.vim — Vim syntax highlighting for zelto slice spec files
"
" File: specs/slices/*.md
" Description: Syntax highlighting for zelto slice specification files
" Maintainer: zelto project
"
" Installation:
"   Place this file in ~/.vim/syntax/zelto-slice.vim
"   Place ftdetect/zelto-slice.vim in ~/.vim/ftdetect/zelto-slice.vim
"   Or use a plugin manager with the syntax/ directory of this project.

if exists("b:current_syntax")
  finish
endif

" ============================================================================
" YAML Frontmatter
" ============================================================================
" Highlight YAML frontmatter delimited by ---
syn region zeltoYAMLFrontmatter matchgroup=zeltoYAMLDelimiter
      \ start="^---$" end="^---$" keepend
      \ containedin=TOP

" ============================================================================
" Section Titles
" ============================================================================
" Highlight lines starting with ## (level-2 headings, used in zelto specs)
syn match zeltoSectionTitle "^## .*$"
      \ contains=zeltoTodo

" ============================================================================
" Status Lines
" ============================================================================
" Highlight Status: xxx lines (e.g., "Status: draft", "Status: completed")
syn match zeltoStatusLine "^Status:.*$"

" ============================================================================
" Refs-Slice Trailer
" ============================================================================
" Highlight Refs-Slice: trailer in commit messages
syn match zeltoRefsSlice "Refs-Slice:\s*<[^>]*>"

" ============================================================================
" Slice ID References
" ============================================================================
" Highlight [id-xxx] patterns (e.g., [id-v1-main], [id-v1-vim-syntax])
syn match zeltoSliceID "\[id[-_][a-zA-Z0-9_-]\+]"

" ============================================================================
" Code Blocks
" ============================================================================
" Highlight fenced code blocks (```)
syn region zeltoCodeBlock matchgroup=zeltoCodeBlockDelimiter
      \ start="^```" end="^```" keepend
      \ contains=zeltoTodo

" ============================================================================
" Checklist Items
" ============================================================================
" Highlight completed checklist items (- [x])
syn match zeltoChecklistDone "^- \[x\].*$"

" Highlight pending checklist items (- [ ])
syn match zeltoChecklistTodo "^- \[ \].*$"

" ============================================================================
" TODO / FIXME / HACK Markers
" ============================================================================
" Highlight TODO, FIXME, HACK, NOTE, XXX, OPTIMIZE markers
syn keyword zeltoTodo TODO FIXME HACK NOTE XXX OPTIMIZE contained
      \ containedin=zeltoCodeBlock,zeltoBlockquote,zeltoYAMLFrontmatter

" ============================================================================
" Blockquotes
" ============================================================================
" Highlight lines starting with >
syn region zeltoBlockquote matchgroup=zeltoBlockquoteMarker
      \ start="^> " end="^[^>]"me=e-1,^\(```\)\@=
      \ contains=zeltoTodo,zeltoSliceID,zeltoMarkdownLink

" ============================================================================
" Markdown Links
" ============================================================================
" Highlight [text](url) links
syn match zeltoMarkdownLink "\[[^]]*\]([^)]*)"

" ============================================================================
" Define Highlight Colors
" ============================================================================
" Link to standard Vim highlight groups for compatibility with all color schemes
hi def link zeltoYAMLFrontmatter    PreProc
hi def link zeltoYAMLDelimiter      Delimiter
hi def link zeltoSectionTitle       Title
hi def link zeltoStatusLine         Special
hi def link zeltoRefsSlice          Special
hi def link zeltoSliceID            Identifier
hi def link zeltoCodeBlock          String
hi def link zeltoCodeBlockDelimiter Delimiter
hi def link zeltoChecklistDone      Statement
hi def link zeltoChecklistTodo      Comment
hi def link zeltoTodo               Todo
hi def link zeltoBlockquote         Comment
hi def link zeltoBlockquoteMarker   Special
hi def link zeltoMarkdownLink       Underlined

let b:current_syntax = "zelto-slice"
