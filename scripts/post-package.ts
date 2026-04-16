import type { Dirent } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const artifactDir = process.env.ELECTROBUN_ARTIFACT_DIR;
const buildDir = resolve(process.env.ELECTROBUN_BUILD_DIR || "build");
const buildEnv = String(process.env.ELECTROBUN_BUILD_ENV || "").toLowerCase();

if (buildEnv === "release") {
  console.log("post-package: skipping custom bundle zip for release builds.");
  process.exit(0);
}

async function runCommand(cmd: string[]) {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || stdout.trim() || `Command failed: ${cmd.join(" ")}`,
    );
  }
}

function quotePowerShell(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function directoryHasEntries(dirPath: string) {
  try {
    const entries = await readdir(dirPath);
    return entries.length > 0;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code !== "ENOENT"
    ) {
      console.warn(
        `post-package: failed to inspect ${dirPath}: ${String(error)}`,
      );
    }
    return false;
  }
}

async function findPackagedAppDir(rootDir: string) {
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const entries: Dirent[] = await readdir(currentDir, {
      withFileTypes: true,
    }).catch(() => [] as Dirent[]);

    const hasLauncher = entries.some(
      (entry) => entry.isDirectory() && entry.name === "bin",
    );

    if (hasLauncher && (await directoryHasEntries(join(currentDir, "bin")))) {
      const binEntries: string[] = await readdir(join(currentDir, "bin")).catch(
        () => [],
      );
      if (binEntries.includes("launcher.exe")) {
        return currentDir;
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(join(currentDir, entry.name));
      }
    }
  }

  return null;
}

async function resolveArchiveSourceDir() {
  if (artifactDir) {
    const resolvedArtifactDir = resolve(artifactDir);
    if (await directoryHasEntries(resolvedArtifactDir)) {
      return resolvedArtifactDir;
    }
  }

  return findPackagedAppDir(buildDir);
}

const sourceDir = await resolveArchiveSourceDir();

if (!sourceDir) {
  console.warn(
    "post-package: no packaged app directory was found, skipping archive step.",
  );
  process.exit(0);
}

const resolvedSourceDir = sourceDir;
const artifactParentDir = dirname(resolvedSourceDir);
const artifactBaseName = basename(resolvedSourceDir);
const zipPath = join(artifactParentDir, `${artifactBaseName}.zip`);

async function archiveOnWindows() {
  const powerShell = Bun.which("pwsh") || Bun.which("powershell");

  if (!powerShell) {
    throw new Error("PowerShell is required to create Windows zip artifacts.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "tts-desktop-post-package-"));
  const scriptPath = join(tempDir, "zip-bundle.ps1");

  try {
    const zipScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$Source = ${quotePowerShell(resolvedSourceDir)}`,
      `$Destination = ${quotePowerShell(zipPath)}`,
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

    await writeFile(scriptPath, zipScript, "utf8");

    await runCommand([
      powerShell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function archiveOnUnix() {
  const zipBinary = Bun.which("zip");

  if (!zipBinary) {
    throw new Error(
      "The 'zip' command is required to create archive artifacts on this platform.",
    );
  }

  await runCommand([zipBinary, "-r", zipPath, artifactBaseName]);
}

await rm(zipPath, { force: true }).catch(() => undefined);

if (process.platform === "win32") {
  await archiveOnWindows();
} else {
  const previousDirectory = process.cwd();
  process.chdir(artifactParentDir);

  try {
    await archiveOnUnix();
  } finally {
    process.chdir(previousDirectory);
  }
}

console.log(`post-package: created ${zipPath}`);
