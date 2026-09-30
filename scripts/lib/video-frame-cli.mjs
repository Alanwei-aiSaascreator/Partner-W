import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function extractFrame(argv, execute = spawnSync) {
  const [input, ...rest] = argv;
  if (!input || input.startsWith('-'))
    throw new Error('Usage: frame.mjs <video-file> [--time HH:MM:SS] [--index N] --out frame.jpg');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i],
      value = rest[i + 1];
    if (!['--time', '--index', '--out'].includes(name) || !value || Object.hasOwn(options, name))
      throw new Error(`Invalid argument: ${name}`);
    options[name] = value;
  }
  if (!options['--out']) throw new Error('Missing --out');
  if (options['--index'] && !/^\d+$/.test(options['--index'])) throw new Error('Invalid frame index');
  if (options['--time'] && !/^(?:\d+:)?[0-5]?\d:[0-5]?\d(?:\.\d+)?$/.test(options['--time']))
    throw new Error('Invalid timestamp');
  if (options['--index'] && options['--time']) throw new Error('Use either --time or --index');
  const source = path.resolve(input),
    output = path.resolve(options['--out']);
  if (!fs.statSync(source).isFile()) throw new Error('Input is not a file');
  if (!/\.(?:jpe?g|png)$/i.test(output) || source === output)
    throw new Error('Output must be a distinct JPG or PNG file');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.frame-${randomUUID()}${path.extname(output)}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (options['--time']) args.push('-ss', options['--time']);
  args.push('-i', source);
  if (!options['--time']) args.push('-vf', `select=eq(n\\,${options['--index'] ?? '0'})`);
  args.push('-frames:v', '1', temporary);
  try {
    const result = execute('ffmpeg', args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `ffmpeg failed (${result.status})`);
    if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0)
      throw new Error('ffmpeg did not produce a frame');
    fs.renameSync(temporary, output);
    return output;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(extractFrame(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
