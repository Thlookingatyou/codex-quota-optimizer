# Try the skill from PowerShell on Windows

The snippets below require PowerShell 7, Git, and Node.js 22.12 or later. They run
directly from a disposable checkout, without installing the skill.

These commands were verified in a disposable checkout on Windows 11 Home Single
Language, version 10.0.26300 (build 26300), PowerShell 7.5.4, and Node.js v25.2.1.
The verification included a synthetic JSONL file whose path contained spaces,
manual demo inputs, and a missing-file response.

## Check Node and clone

```powershell
$PSVersionTable.PSVersion
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Open PowerShell 7 before continuing.'
}
node --version
git --version
if ([version]((node --version).TrimStart('v')) -lt [version]'22.12.0') {
    throw 'Node.js 22.12 or later is required.'
}

$projectPath = Join-Path ([IO.Path]::GetTempPath()) 'codex quota walkthrough'
git clone --depth 1 https://github.com/Thlookingatyou/codex-quota-optimizer.git "$projectPath"
if ($LASTEXITCODE -ne 0) { throw 'Clone failed. Choose an empty destination.' }
Set-Location -LiteralPath $projectPath
$reader = './skills/codex-quota-optimizer/scripts/check_quota.mjs'
```

## Run a dependency-free demo

Use a missing fixture path and explicit simulated values. Both quota windows
are manual inputs in this example. The result identifies them as
`cli_or_env_override` and `manual_override`.

```powershell
$missingFile = Join-Path $projectPath 'missing demo rollout.jsonl'
node $reader "--rollout-file=$missingFile" --5h=10 --weekly=20 --5h-reset-sec=3600 --weekly-reset-sec=604800 --format=json
```

To exercise JSONL parsing with a fresh synthetic observation, create a fixture
inside the checkout.

```powershell
$fixturePath = Join-Path $projectPath 'synthetic quota.jsonl'
$event = @{
    timestamp = [DateTime]::UtcNow.ToString('o')
    payload = @{ rate_limits = @{
        limit_id = 'codex'
        primary = @{ used_percent = 10; window_minutes = 300; resets_in_seconds = 3600 }
        secondary = @{ used_percent = 20; window_minutes = 10080; resets_in_seconds = 604800 }
    } }
}
$event | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $fixturePath -Encoding utf8NoBOM
node $reader "--rollout-file=$fixturePath" --format=json
Remove-Item -LiteralPath $fixturePath
```

The usage values should be 10 and 20. Quote the complete
`"--rollout-file=$fixturePath"` argument so a path containing spaces reaches
Node as one argument.

## Read a chosen local rollout

Replace this example with the path to a rollout you want to inspect.

```powershell
$rolloutPath = 'C:\My Codex Data\sessions\rollout-example.jsonl'
node $reader "--rollout-file=$rolloutPath" --format=json
```

The reader only reads the chosen file. Missing or malformed observations produce
`TELEMETRY_UNKNOWN` with null usage. Observations older than 15 minutes, expired
resets, or unsupported window durations can also leave usage unknown. A reset
countdown reaching zero does not establish the new usage.

To reproduce missing telemetry, run the missing-file command without the manual
overrides.

```powershell
node $reader "--rollout-file=$missingFile" --format=json
```

## If PowerShell cannot find Node

```powershell
Get-Command node -ErrorAction SilentlyContinue
where.exe node
& 'C:\Program Files\nodejs\node.exe' --version
```

If the absolute command works, open a new PowerShell window after installing
Node so it receives the updated PATH. When several copies appear, compare
`Get-Command node` with the version you intend to use.

## Installation is a separate step

The demo writes only its synthetic fixture in the checkout. Reading an existing
rollout is read-only. The [installation instructions](../README.md#install)
describe copying files into the user skills directory. The shell installer also
updates global `AGENTS.md` and `config.toml`. Review that installer before choosing
to install. The walkthrough above can be used directly from the checkout.
