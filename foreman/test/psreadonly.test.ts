// The read-only PowerShell recogniser auto mode uses for the lead: real inspection scripts a lead
// ran (they must pass) and the ways a script could change or leak something (they must not).
import { describe, expect, it } from 'vitest';
import { psReadOnlyProblem } from '../src/psreadonly.js';

const roots = ['D:\\Mending-Labs', 'D:\\Popo'];
const ok = (s: string) => expect(psReadOnlyProblem(s, roots)).toBeUndefined();
const no = (s: string, why: RegExp) => expect(psReadOnlyProblem(s, roots)).toMatch(why);

describe.runIf(process.platform === 'win32')('psReadOnlyProblem', () => {
  it('accepts the inspection scripts a lead actually ran', () => {
    ok(`Get-ChildItem -LiteralPath 'D:\\Mending-Labs' -Directory -Force | ForEach-Object { $folder = $_; Get-ChildItem -LiteralPath $folder.FullName -Force | Select-Object @{Name='Parent';Expression={$folder.Name}},Mode,Name }`);
    ok(`Get-ChildItem -LiteralPath 'D:\\Mending-Labs' -Directory -Force | ForEach-Object { $marker = Join-Path $_.FullName '.git'; if (Test-Path -LiteralPath $marker -PathType Leaf) { Write-Output ('WORKTREE ' + $_.Name); Get-Content -LiteralPath $marker } }; Get-ChildItem -LiteralPath 'D:\\Mending-Labs\\labs','D:\\Mending-Labs\\IA' -Force | Select-Object FullName,Mode`);
    ok(`Get-ChildItem -LiteralPath 'D:\\Mending-Labs' -Directory -Force | ForEach-Object { $folder = $_; $marker = Join-Path $folder.FullName '.git'; if (Test-Path -LiteralPath $marker -PathType Leaf) { Write-Output ('DOSSIER ' + $folder.Name); git --no-optional-locks -C $folder.FullName status --short --untracked-files=no } }; Get-ChildItem -LiteralPath 'D:\\Mending-Labs\\design' -Force | Measure-Object | Select-Object Count`);
    ok(`Get-ChildItem -LiteralPath 'D:\\Popo\\Dev' -Directory -Force | ForEach-Object { $gitMarker = Join-Path $_.FullName '.git'; if (Test-Path -LiteralPath $gitMarker) { Get-Item -LiteralPath $gitMarker -Force | Select-Object FullName,Mode } }; Get-Content -LiteralPath 'D:\\Popo\\GazHabitatFormation\\README.md' -TotalCount 65; Select-String -LiteralPath 'D:\\Popo\\MineOps\\README.md' -SimpleMatch -Pattern 'D:\\Popo','D:/Popo'`);
    ok(`git -C D:\\Popo\\MineOps worktree list --porcelain`);
    ok(`foreach ($d in Get-ChildItem 'D:\\Popo') { if (-not (Test-Path (Join-Path $d.FullName '.git'))) { "$d has no git" } }`);
  });

  it('refuses commands that change things', () => {
    no(`Get-ChildItem 'D:\\Popo' | Remove-Item -Recurse`, /Remove-Item/);
    no(`Get-ChildItem 'D:\\Popo' | ForEach-Object { Move-Item $_.FullName 'D:\\Popo\\x' }`, /Move-Item/);
    no(`Get-ChildItem 'D:\\Popo' | ForEach-Object Delete`, /script block/);
    no(`Get-ChildItem 'D:\\Popo' | % -MemberName Delete`, /script block/);
    no(`Get-ChildItem 'D:\\Popo' | ForEach-Object { $_.Delete() }`, /method/);
    no(`[IO.Directory]::Delete('D:\\Popo\\x', $true)`, /static/);
    no(`Get-Content 'D:\\Popo\\a' > 'D:\\Popo\\b'`, /redirection/);
    no(`& 'D:\\Popo\\run.ps1'`, /call operator/);
    no(`. 'D:\\Popo\\setup.ps1'`, /dot-sourcing/);
    no(`git -C 'D:\\Popo\\MineOps' checkout main`, /git checkout/);
    no(`git -C 'D:\\Popo\\MineOps' worktree remove x`, /git worktree/);
    no(`Get-ChildItem 'D:\\Popo' | Select-Object @{Name='x';Expression={ Remove-Item 'D:\\Popo\\a' }}`, /Remove-Item/);
    no(`Write-Output "$(Remove-Item 'D:\\Popo\\a')"`, /subexpression/);
    no(`foreach ($d in Remove-Item 'D:\\Popo\\x') { }`, /Remove-Item/);
    no(`iex 'Remove-Item D:\\Popo\\a'`, /iex/);
  });

  it('refuses reads outside the repo and the workspaces', () => {
    no(`Get-Content 'C:\\Users\\Quentin\\.ssh\\id_rsa'`, /outside/);
    no(`Get-Content "$env:USERPROFILE\\.ssh\\id_rsa"`, /scoped variable \$env/);
    no(`Get-Content $HOME\\.ssh\\id_rsa`, /variable \$HOME/);
    no(`Get-Content ~\\.ssh\\id_rsa`, /home folder/);
    no(`Get-Content 'D:\\Popo\\..\\secrets.txt'`, /walking up/);
    no(`Get-ChildItem Env:`, /provider/);
    no(`Get-Content C:secret.txt`, /drive-relative/);
    no(`Get-Content '\\\\server\\share\\x'`, /UNC/);
  });
});
