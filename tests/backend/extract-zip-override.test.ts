import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'

interface ZipEntry {
  name: string
  contents: string
  symlink?: boolean
}

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function writeZip(path: string, entries: ZipEntry[]) {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const contents = Buffer.from(entry.contents)
    const checksum = crc32(contents)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(contents.length, 18)
    local.writeUInt32LE(contents.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    localParts.push(local, contents)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.symlink ? 3 << 8 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(contents.length, 20)
    central.writeUInt32LE(contents.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(entry.symlink ? ((0xa000 | 0o777) << 16) >>> 0 : 0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralParts.push(central)
    localOffset += local.length + contents.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const localDirectory = Buffer.concat(localParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localDirectory.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localDirectory, centralDirectory, end]))
}

describe('extract-zip override', () => {
  it('extracts a nested file inside the staging directory', async () => {
    const root = tempDirectory('gooeypi-extract-zip-')
    const staging = join(root, 'staging')
    const archive = join(root, 'nested.zip')
    writeZip(archive, [{ name: 'nested/file.txt', contents: 'inside' }])

    await extractZip(archive, { dir: staging })

    expect(readFileSync(join(staging, 'nested/file.txt'), 'utf8')).toBe('inside')
  })

  it.skipIf(process.platform === 'win32')('does not extract a symlink outside the staging directory', async () => {
    const root = tempDirectory('gooeypi-extract-zip-')
    const outside = join(root, 'outside')
    const staging = join(root, 'staging')
    const archive = join(root, 'symlink.zip')
    const outsideFile = join(outside, 'evil.txt')
    mkdirSync(outside)
    writeZip(archive, [
      { name: 'escape', contents: outsideFile, symlink: true },
      { name: 'escape/evil.txt', contents: 'outside' },
    ])

    await extractZip(archive, { dir: staging }).catch(() => undefined)

    expect(existsSync(outsideFile)).toBe(false)
  })

  it('rejects an entry that traverses outside the staging directory', async () => {
    const root = tempDirectory('gooeypi-extract-zip-')
    const staging = join(root, 'staging')
    const archive = join(root, 'traversal.zip')
    const outsideFile = join(root, 'evil.txt')
    writeZip(archive, [{ name: '../evil.txt', contents: 'outside' }])

    await expect(extractZip(archive, { dir: staging })).rejects.toThrow()
    expect(existsSync(outsideFile)).toBe(false)
  })
})
