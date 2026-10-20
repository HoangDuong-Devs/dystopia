// Repo git giả cho test engine native. Tên file là giả (src/file1.ts...), không
// chứa code thật của repo nào.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

export async function makeNativeRepo(t, options = {}) {
  const count = options.files ?? 4;
  const bigLines = options.bigLines ?? 450;
  const changeBig = options.changeBig === true;
  const root = await mkdtemp(path.join(tmpdir(), 'dystopia-native-'));
  const dir = path.join(root, 'repo');
  await mkdir(dir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.invalid']);
  await git(dir, ['config', 'user.name', 'Test']);

  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const files = [];
  for (let index = 1; index <= count; index += 1) {
    const file = `src/file${index}.ts`;
    files.push(file);
    await writeFile(path.join(dir, file), `export const value${index} = 1;\n`);
  }
  const big = Array.from({ length: bigLines }, (_value, index) => `line ${index + 1}`).join('\n');
  await writeFile(path.join(dir, 'src', 'big.ts'), `${big}\n`);
  await writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  await writeFile(path.join(dir, 'dist', 'bundle.js'), 'console.log(1);\n');
  await writeFile(path.join(dir, 'assets', 'data.bin'), Buffer.from([0, 0, 1, 2, 3]));

  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', 'base']);
  const base = await git(dir, ['rev-parse', 'HEAD']);

  for (let index = 1; index <= count; index += 1) {
    const file = `src/file${index}.ts`;
    await writeFile(
      path.join(dir, file),
      `export const value${index} = 1;\nexport const value${index}b = 2;\nexport const value${index}c = 3;\n`,
    );
  }
  await writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3, "changed": true}\n');
  if (changeBig) {
    await writeFile(path.join(dir, 'src', 'big.ts'), `${big}\nappended 451\nappended 452\nappended 453\n`);
  }
  await writeFile(path.join(dir, 'dist', 'bundle.js'), 'console.log(2);\n');
  await writeFile(path.join(dir, 'assets', 'data.bin'), Buffer.from([0, 0, 4, 5, 6]));

  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', 'head']);
  const head = await git(dir, ['rev-parse', 'HEAD']);

  const outside = path.join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'src', 'link-out'));

  return { root, dir, base, head, files, big: 'src/big.ts', outside };
}
