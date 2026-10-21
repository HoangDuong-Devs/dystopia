// Cấu hình thư mục của Dystopia: DYSTOPIA_HOME, agent dir riêng, Pi SDK và
// sandbox-exec của MTH. Không dùng agent dir hay .env của MTH.
//
// Chỉ dùng module có sẵn của Node.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EngineError } from '../ocr.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function valueOf(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function configError(message, code) {
  return new EngineError(message, { code, exitCode: 64 });
}

// Thư mục cài Dystopia: DYSTOPIA_HOME nếu đặt, mặc định thư mục chứa launcher.
export function dystopiaHome(env = process.env) {
  const home = valueOf(env, 'DYSTOPIA_HOME');
  return path.resolve(home !== '' ? home : ROOT);
}

// Agent dir riêng của Dystopia: mặc định $DYSTOPIA_HOME/agent.
export function agentDir(env = process.env) {
  const dir = valueOf(env, 'DYSTOPIA_AGENT_DIR');
  return path.resolve(dir !== '' ? dir : path.join(dystopiaHome(env), 'agent'));
}

export function modelsPath(env = process.env) {
  return path.join(agentDir(env), 'models.json');
}

export function envFilePath(env = process.env) {
  const file = valueOf(env, 'DYSTOPIA_ENV_FILE');
  return path.resolve(file !== '' ? file : path.join(dystopiaHome(env), '.env'));
}

// MTH_HOME chỉ còn dùng để tìm sandbox-exec.sh của MTH; vẫn bắt buộc với engine native.
export function resolveMthHome(env = process.env) {
  const home = valueOf(env, 'MTH_HOME');
  if (home === '') {
    throw configError(
      'chưa đặt MTH_HOME: đặt MTH_HOME tới thư mục cài MTH (chỉ cần $MTH_HOME/lib/sandbox-exec.sh)',
      'MTH_HOME_MISSING',
    );
  }
  return path.resolve(home);
}

export function sandboxScriptPath(env = process.env) {
  return path.join(resolveMthHome(env), 'lib', 'sandbox-exec.sh');
}

// Pi SDK: DYSTOPIA_PI_SDK nếu đặt, mặc định cạnh Dystopia ($DYSTOPIA_HOME/../pi).
export function piSdkPath(env = process.env, home = dystopiaHome(env)) {
  const override = valueOf(env, 'DYSTOPIA_PI_SDK');
  if (override !== '') {
    const resolved = path.resolve(override);
    return resolved.endsWith('.js') ? resolved : path.join(resolved, 'dist', 'index.js');
  }
  return path.resolve(home, '..', 'pi', 'packages', 'coding-agent', 'dist', 'index.js');
}
