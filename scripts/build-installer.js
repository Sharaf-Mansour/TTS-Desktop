import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const channel = process.argv[2] || "stable";
const projectRoot = process.cwd();
const buildRoot = join(projectRoot, "build");
const artifactsRoot = join(projectRoot, "artifacts");
const electrobunBinary = resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electrobun.exe" : "electrobun",
);

function sanitizeZipStem(stem) {
  return stem.replace(/ /g, "");
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runCommand(cmd) {
  const proc = Bun.spawn({
    cmd,
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc.exited;
}

async function findBuildFolder() {
  if (!existsSync(buildRoot)) {
    return null;
  }

  const entries = await readdir(buildRoot, { withFileTypes: true });
  const matchingFolder = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith(`${channel}-win-`),
  );

  return matchingFolder ? join(buildRoot, matchingFolder.name) : null;
}

async function getInstallerFileSet(buildFolder) {
  const entries = await readdir(buildFolder);
  const metadataFile = entries.find((entry) => entry.endsWith(".metadata.json"));

  if (!metadataFile) {
    return null;
  }

  const stem = metadataFile.slice(0, -".metadata.json".length);
  const exePath = join(buildFolder, `${stem}.exe`);
  const archivePath = join(buildFolder, `${stem}.tar.zst`);
  const metadataPath = join(buildFolder, metadataFile);

  if (!existsSync(exePath) || !existsSync(archivePath) || !existsSync(metadataPath)) {
    return null;
  }

  return {
    stem,
    exePath,
    archivePath,
    metadataPath,
    zipPath: join(buildFolder, `${sanitizeZipStem(stem)}.zip`),
  };
}

async function createInstallerZip(fileSet) {
  const powerShell = Bun.which("pwsh") || Bun.which("powershell");

  if (!powerShell) {
    throw new Error("PowerShell is required to build the Windows installer package.");
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "tts-desktop-installer-"));
  const stagingInstallerDir = join(stagingRoot, ".installer");
  const zipScriptPath = join(stagingRoot, "zip-installer.ps1");

  try {
    await mkdir(stagingInstallerDir, { recursive: true });
    await copyFile(fileSet.exePath, join(stagingRoot, basename(fileSet.exePath)));
    await copyFile(
      fileSet.metadataPath,
      join(stagingInstallerDir, basename(fileSet.metadataPath)),
    );
    await copyFile(
      fileSet.archivePath,
      join(stagingInstallerDir, basename(fileSet.archivePath)),
    );

    const zipScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$Source = ${quotePowerShell(stagingRoot)}`,
      `$Destination = ${quotePowerShell(fileSet.zipPath)}`,
      "if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }",
      "$zip = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)",
      "try {",
      "  Get-ChildItem -LiteralPath $Source -Recurse -File | ForEach-Object {",
      "    $relative = [System.IO.Path]::GetRelativePath($Source, $_.FullName)",
      "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
      "  }",
      "} finally {",
      "  $zip.Dispose()",
      "}",
    ].join("\r\n");

    await writeFile(zipScriptPath, zipScript, "utf8");

    const exitCode = await runCommand([
      powerShell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      zipScriptPath,
    ]);

    if (exitCode !== 0 || !existsSync(fileSet.zipPath)) {
      throw new Error("Failed to create the Windows installer zip package.");
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeUpdateJson(buildFolderName, metadataPath) {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const updateJsonPath = join(artifactsRoot, `${buildFolderName}-update.json`);

  await writeFile(
    updateJsonPath,
    JSON.stringify(
      {
        version: packageJson.version,
        hash: metadata.hash,
        platform: "win",
        arch: process.arch,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function publishArtifacts(buildFolder, fileSet) {
  const buildFolderName = basename(buildFolder);

  await mkdir(artifactsRoot, { recursive: true });
  await writeUpdateJson(buildFolderName, fileSet.metadataPath);

  const filesToCopy = [fileSet.exePath, fileSet.archivePath, fileSet.metadataPath, fileSet.zipPath];

  for (const filePath of filesToCopy) {
    const destination = join(artifactsRoot, `${buildFolderName}-${basename(filePath)}`);
    await copyFile(filePath, destination);
  }
}

async function recoverInstallerArtifacts() {
  const buildFolder = await findBuildFolder();
  if (!buildFolder) {
    return false;
  }

  const fileSet = await getInstallerFileSet(buildFolder);
  if (!fileSet) {
    return false;
  }

  if (!existsSync(fileSet.zipPath)) {
    await createInstallerZip(fileSet);
  }

  await publishArtifacts(buildFolder, fileSet);
  console.log(`Recovered installer artifacts in ${artifactsRoot}`);
  return true;
}

if (!existsSync(electrobunBinary)) {
  throw new Error(`Electrobun binary not found at ${electrobunBinary}`);
}

const exitCode = await runCommand([electrobunBinary, "build", `--env=${channel}`]);

if (exitCode === 0) {
  const recovered = await recoverInstallerArtifacts();
  if (!recovered) {
    console.log("Electrobun build completed without needing installer recovery.");
  }
  process.exit(0);
}

const recovered = await recoverInstallerArtifacts();
if (recovered) {
  console.warn("Electrobun build reported a packaging failure, but installer artifacts were recovered successfully.");
  process.exit(0);
}

process.exit(exitCode);