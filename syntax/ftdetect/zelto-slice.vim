" ftdetect/zelto-slice.vim — Auto-detect zelto slice spec files
"
" Automatically applies the zelto-slice syntax to .md files
" located under specs/slices/ directory.

au BufRead,BufNewFile specs/slices/*.md set filetype=zelto-slice
