# Release 工作流用：把一个安装包挂到 tag 对应的草稿 Release 上，并在说明里加一行哈希。
# Windows 和 macOS 两个 job 谁先跑完不一定，所以是"没有就建，有就追加"。
param(
  [Parameter(Mandatory)] [string] $Tag,
  [Parameter(Mandatory)] [string] $File,
  [Parameter(Mandatory)] [string] $Line
)
$ErrorActionPreference = "Stop"

gh release view $Tag *> $null
if ($LASTEXITCODE -ne 0) {
  gh release create $Tag --draft --prerelease --title "Enclave $Tag" --notes "Unsigned preview. Verify the SHA256 before installing."
  # 另一个 job 可能抢先建好了，那也算成功。
  if ($LASTEXITCODE -ne 0) { gh release view $Tag *> $null; if ($LASTEXITCODE -ne 0) { throw "release create failed" } }
}
gh release upload $Tag $File --clobber
if ($LASTEXITCODE -ne 0) { throw "release upload failed" }

$body = (gh release view $Tag --json body --jq .body) -join "`n"
gh release edit $Tag --notes ($body + "`n" + $Line)
if ($LASTEXITCODE -ne 0) { throw "release edit failed" }
