" ftdetect/slice.vim — Auto-detect zelto slice spec files
"
" Automatically applies the slice syntax to .md files
" located under specs/slices/ directory.

au BufRead,BufNewFile specs/slices/*.md set filetype=slice
