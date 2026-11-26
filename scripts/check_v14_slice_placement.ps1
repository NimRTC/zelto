param(
  [string]$Repo = 'D:/MyOpen/nimrtc-v14',
  [string]$Base = 'origin/main'
)

$ErrorActionPreference = 'Continue'
$isAncestor = {
  param($sha, $ref)
  git -C $Repo merge-base --is-ancestor $sha $ref 2>$null
  return ($LASTEXITCODE -eq 0)
}

$slices = @(
  @('v1-turn-tls','N1','29d3cb0b'), @('v2-ice','N2','dd396cd5'), @('v1-ice-recovery','N3','8abb815a'),
  @('v3-n4-d6-connectivity','N4+D6','59b09f02'), @('v1-n5-turn-server','N5','14eeee08'),
  @('v1-sdk-sample','N6','657941be'), @('v1-turn-credentials','N7','3529b44a'),
  @('v1-path-change-report','N8','b4aa77ec'), @('v1-macos-install-proof','N9','18775f73'),
  @('v1-audio-device-engine','D1','6a1e3a6e'), @('v1-video-render-engine','D2','dbef30f9'),
  @('v1-device-policy','D3+D4','db2dc0de'), @('v1-audio-p2','D5','6b5439da'),
  @('v1-call-state-surface','D7','5524165f'), @('v1-turn-tls-trust','N6-gap','ac2eeac0'),
  @('v1-install-tree-video-deps','N6-gap','884c3c10'), @('v6-writeset-slice-boundary','utils','41e6f157'),
  @('v1-install-tree-module-closure','utils','d7e4ba65')
)
$branches = @('version/v1','version/v2','version/v3','version/v4','feat/v14-turn-tls','origin/feat/v14-turn-tls',$Base)

$header = "{0,-30} {1,-8} {2,-8}" -f 'slice','gap','sha'
foreach ($b in $branches) { $header += (' {0,-14}' -f $b) }
Write-Output $header

foreach ($s in $slices) {
  $name, $gap, $sha = $s
  $exists = git -C $Repo cat-file -t $sha 2>$null
  if ($LASTEXITCODE -ne 0) { $exists = 'MISSING' }
  $line = "{0,-30} {1,-8} {2,-8}" -f $name, $gap, $exists
  foreach ($b in $branches) {
    if ($exists -eq 'MISSING') { $cell = '-' }
    elseif (& $isAncestor $sha $b) { $cell = 'YES' }
    else { $cell = 'no' }
    $line += (' {0,-14}' -f $cell)
  }
  Write-Output $line
}

Write-Output ''
Write-Output "--- ahead / behind vs $Base"
foreach ($b in $branches) {
  $ahead  = git -C $Repo rev-list --count "$b" "^$Base" 2>$null
  $behind = git -C $Repo rev-list --count "$Base" "^$b" 2>$null
  "{0,-28} ahead={1,-4} behind={2}" -f $b, $ahead, $behind
}
