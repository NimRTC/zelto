" Vim syntax file for zelto slice specification (.md files tagged as slice specs)
" Language: zelto Slice Spec
" Maintainer: zelto team
" Version: 1.0.0

if exists("b:current_syntax")
  finish
endif

" Slice spec files are Markdown files with YAML frontmatter.
" We only activate this syntax when the file is in specs/slices/ directory
" or when the first line contains '---' (YAML frontmatter start).
"
" Usage: Place in ~/.vim/syntax/slice.vim and set filetype detection.

" YAML frontmatter (between --- delimiters)
syntax region sliceYAMLFrontmatter matchgroup=sliceYAMLDelim start="^---$" end="^---$" keepend contains=sliceYAMLKey,sliceYAMLValue,sliceYAMLComment

syntax match sliceYAMLComment "#.*$" contained
syntax match sliceYAMLKey "^[a-zA-Z_][a-zA-Z0-9_]*:" contained
syntax match sliceYAMLValue ":\s*\zs.*$" contained

" Section headers (## Section Title)
syntax match sliceSectionHead "^##\s\+.*$" contains=sliceSectionMarker
syntax match sliceSectionMarker "^##" contained

" Sub-section headers (### Sub-section)
syntax match sliceSubSectionHead "^###\s\+.*$" contains=sliceSubSectionMarker
syntax match sliceSubSectionMarker "^###" contained

" Status badges: [status:xxx]
syntax match sliceStatusBadge "\[status:[a-zA-Z_]*\]" contains=sliceStatusKeyword
syntax match sliceStatusKeyword "\[status:" contained nextgroup=sliceStatusValue
syntax match sliceStatusValue "[a-zA-Z_]*\]" contained

" Priority badges: [priority:xxx]
syntax match slicePriorityBadge "\[priority:[a-zA-Z_]*\]" contains=slicePriorityKeyword
syntax match slicePriorityKeyword "\[priority:" contained nextgroup=slicePriorityValue
syntax match slicePriorityValue "[a-zA-Z_]*\]" contained

" Slice IDs: `slc-xxx` or `SLC-XXX`
syntax match sliceID "`slc-[a-zA-Z0-9_-]*`" contains=sliceIDBacktick
syntax match sliceIDBacktick "`" contained

" Links: [text](url)
syntax match sliceLink "\[.*\]([^)]*)" contains=sliceLinkText,sliceLinkURL
syntax match sliceLinkText "\[.*\]" contained
syntax match sliceLinkURL "(.*)" contained

" Inline code
syntax region sliceInlineCode matchgroup=sliceCodeDelim start="`" end="`" keepend

" Code blocks (triple backtick)
syntax region sliceCodeBlock matchgroup=sliceCodeBlockDelim start="^```" end="^```" keepend

" Blockquotes
syntax region sliceBlockquote start="^>" end="$" keepend

" Lists: -, *, 1. etc.
syntax match sliceListItem "^\(\s*\)[-*]\s\+.*$" contains=sliceListMarker
syntax match sliceListMarker "[-*]" contained

" Horizontal rules
syntax match sliceHR "^---$"

" Highlights
highlight default link sliceYAMLDelim    Delimiter
highlight default link sliceYAMLKey      Identifier
highlight default link sliceYAMLValue    String
highlight default link sliceYAMLComment  Comment

highlight default link sliceSectionHead  Title
highlight default link sliceSectionMarker PreProc
highlight default link sliceSubSectionHead  Title
highlight default link sliceSubSectionMarker PreProc

highlight default link sliceStatusBadge  Special
highlight default link sliceStatusKeyword Identifier
highlight default link sliceStatusValue  String

highlight default link slicePriorityBadge Special
highlight default link slicePriorityKeyword Identifier
highlight default link slicePriorityValue String

highlight default link sliceID           Identifier
highlight default link sliceIDBacktick   Delimiter

highlight default link sliceLink         Underlined
highlight default link sliceLinkText     Underlined
highlight default link sliceLinkURL      String

highlight default link sliceInlineCode   String
highlight default link sliceCodeDelim    Delimiter
highlight default link sliceCodeBlock    String
highlight default link sliceCodeBlockDelim Delimiter

highlight default link sliceBlockquote   Comment
highlight default link sliceListItem     Normal
highlight default link sliceListMarker   Special

highlight default link sliceHR           Identifier

let b:current_syntax = "slice"
