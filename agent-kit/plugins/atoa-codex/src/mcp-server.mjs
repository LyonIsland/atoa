#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME_ENV = process.env.ATOA_HOME || '';
const env = { ...process.env, ...(HOME_ENV ? { ATOA_HOME: HOME_ENV } : {}) };

function resolveCli() {
  const candidates = [
    process.env.ATOA_CLI,
    path.join(os.homedir(), '.local', 'bin', 'atoa'),
    path.join(os.homedir(), '.local', 'share', 'atoa', 'cli', 'atoa.mjs'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ATOA', 'atoa.mjs') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ATOA', 'bin', 'atoa.cmd') : ''
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) return { command: 'atoa', prefix: [] };
  return found.endsWith('.mjs')
    ? { command: process.execPath, prefix: [found] }
    : { command: found, prefix: [] };
}

const CLI = resolveCli();

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI.command, [...CLI.prefix, ...args, '--format', 'agent'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new Error(`ATOA CLI 启动失败：${error.message}。请重新运行 Agent Kit 安装器。`)));
    child.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `atoa exited ${code}`)));
  });
}

const tools = [
  { name: 'atoa_status', description: '检查 ATOA 客户端 Agent 身份、贡献统计和委派任务统计。', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'atoa_delegate_create',
    description: '把用户需求发送到 ATOA 服务端；若项目忙碌，CLI 将排队任务交给按需本地 Worker，并在派发后启动新的客户端 Agent。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        objective: { type: 'string', description: '用户希望项目实现的具体目标' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, maxItems: 12 }
      },
      required: ['project_id', 'objective']
    }
  },
  { name: 'atoa_delegate_list', description: '列出 ATOA 服务端控制平面派发给当前客户端 Agent 的任务。', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'atoa_delegate_show', description: '查看一个委派任务的状态、验收标准、事件和当前 Context；领取后返回 Context 文件内容。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'atoa_delegate_usage', description: '查看委派任务实测的 Context 缓存命中/节省下行、候选上行、验证反馈和 API 调用负载。统计为应用层 JSON 字节，不含 TLS、HTTP 头和模型 Token。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'atoa_delegate_claim', description: '以客户端 Agent 身份领取任务；CLI 按 SHA-256 复用源码与项目 Skill 的只读 Context 缓存，只下载缺失内容。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  {
    name: 'atoa_delegate_request_context',
    description: '任务 Context 不足时，向 ATOA 服务端请求更多相关源码或项目 Skill。优先提供缺失符号、具体路径或失败原因。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
        query: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: 20 }
      },
      required: ['task_id', 'reason']
    }
  },
  {
    name: 'atoa_delegate_progress',
    description: '向服务端控制平面记录客户端 Agent 的阶段进展或阻塞信息。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, message: { type: 'string' } },
      required: ['task_id', 'message']
    }
  },
  {
    name: 'atoa_delegate_cancel',
    description: '任务合同或权限存在无法修复的阻塞时，取消当前委派任务并记录原因。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['task_id', 'reason', 'confirmed']
    }
  },
  {
    name: 'atoa_delegate_submit_result',
    description: '把客户端 Agent 生成的候选文件和实现证据返回服务端控制平面；服务器重新审查、运行固定测试，并接受合并或返回修订意见。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        base_revision: { type: 'string' },
        message: { type: 'string', description: '进入项目贡献历史的脱敏简洁说明；不得包含原始 Prompt、凭证、联系方式、本地路径或外部链接' },
        summary: { type: 'string', description: '可公开的脱敏实现说明和关键取舍；不得复制私有任务对话' },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content']
          }
        },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          description: '推荐：基于任务 Context 快照的紧凑原子操作，可替代完整 files 以降低上行负载。',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['replace', 'insert_before', 'insert_after', 'append'] },
              path: { type: 'string' },
              expected_hash: { type: 'string' },
              find: { type: 'string' },
              replacement: { type: 'string' },
              anchor: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['type', 'path']
          }
        },
        reuse_candidate: {
          type: 'boolean',
          description: '候选代码未改变、仅需在服务端策略或环境修复后重新验证时，复用服务端缓存候选而不重复上传。'
        },
        evidence: { type: 'object', description: '客户端执行过的检查、观察和已知限制' },
        confirmed: { type: 'boolean', description: '候选实现处于用户授权范围内时为 true' }
      },
      required: ['task_id', 'base_revision', 'confirmed']
    }
  },
  { name: 'atoa_cloud_projects', description: '列出可由本地 Agent 参与的 ATOA 共创项目及当前 revision。', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'atoa_cloud_create_project',
    description: '为已登录用户创建一个持久化 ATOA 项目，并生成初始页面、可编辑源码和固定测试。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '3-64 位小写字母、数字和连字符组成的稳定项目 ID' },
        name: { type: 'string' },
        description: { type: 'string', description: '项目初始产品描述，至少 20 个字符' },
        confirmed: { type: 'boolean' }
      },
      required: ['id', 'name', 'description', 'confirmed']
    }
  },
  {
    name: 'atoa_cloud_add_project_skill',
    description: '项目创建者为托管项目添加一个只读 Skill，后续由服务端按任务目标作为 Context 下发。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        confirmed: { type: 'boolean' }
      },
      required: ['project_id', 'id', 'name', 'description', 'instructions', 'confirmed']
    }
  },
  {
    name: 'atoa_cloud_add_project_member',
    description: '项目所有者把一个已经注册的 ATOA 用户加入私有托管项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        email: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['project_id', 'email', 'confirmed']
    }
  },
  {
    name: 'atoa_cloud_remove_project_member',
    description: '项目所有者撤销成员的项目访问权限；该成员在项目中的活动任务会被取消。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        member_id: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['project_id', 'member_id', 'confirmed']
    }
  },
  { name: 'atoa_cloud_project', description: '查看一个共创项目的入口、可编辑文件和当前 revision。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  { name: 'atoa_cloud_read_file', description: '读取项目中的一个白名单源码文件，用于诊断或精确审查。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, path: { type: 'string' } }, required: ['project_id', 'path'] } },
  { name: 'atoa_cloud_test', description: '测试项目当前公开 revision；候选代码请使用 atoa_cloud_validate_worktree。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  { name: 'atoa_cloud_history', description: '读取项目最近的代码贡献、审查结果和 revision。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['project_id'] } },
  { name: 'atoa_cloud_checkout', description: '把项目白名单源码检出到受控本地工作区，记录 Hub、基础 revision 和原始文件哈希。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, directory: { type: 'string', description: '可选绝对目录；省略时使用系统临时工作区' } }, required: ['project_id'] } },
  { name: 'atoa_cloud_validate_worktree', description: '在服务器一次性副本验证候选代码，不更新公开项目或贡献历史。', inputSchema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] } },
  { name: 'atoa_cloud_submit_worktree', description: '提交授权范围内的工作区；服务器重新验证并原子更新，成功后默认清理本地工作区。', inputSchema: { type: 'object', properties: { directory: { type: 'string' }, message: { type: 'string' }, keep_worktree: { type: 'boolean' }, confirmed: { type: 'boolean', description: '变更在用户明确授权范围内时为 true' } }, required: ['directory', 'message', 'confirmed'] } },
  { name: 'atoa_cloud_cleanup_worktree', description: '删除一个带有效 ATOA 元数据的本地工作区。', inputSchema: { type: 'object', properties: { directory: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['directory', 'confirmed'] } },
  { name: 'atoa_cloud_submit_change', description: '兼容工具：直接提交完整白名单文件内容；正常贡献应优先使用工作区流程。', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, base_revision: { type: 'string' }, message: { type: 'string' }, files: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, confirmed: { type: 'boolean' } }, required: ['project_id', 'base_revision', 'message', 'files', 'confirmed'] } }
];

async function callTool(name, input = {}) {
  if (name === 'atoa_status') return run(['auth', 'status']);
  if (name === 'atoa_delegate_create') {
    return run([
      'delegate', 'create',
      '--project', input.project_id,
      '--objective', input.objective,
      '--acceptance', JSON.stringify(input.acceptance_criteria || [])
    ]);
  }
  if (name === 'atoa_delegate_list') {
    const args = ['delegate', 'list'];
    if (input.status) args.push('--status', input.status);
    return run(args);
  }
  if (name === 'atoa_delegate_show') return run(['delegate', 'show', '--task', input.task_id]);
  if (name === 'atoa_delegate_usage') return run(['delegate', 'usage', '--task', input.task_id]);
  if (name === 'atoa_delegate_claim') return run(['delegate', 'claim', '--task', input.task_id]);
  if (name === 'atoa_delegate_request_context') {
    return run([
      'delegate', 'request-context',
      '--task', input.task_id,
      '--reason', input.reason,
      '--query', input.query || '',
      '--paths', JSON.stringify(input.paths || [])
    ]);
  }
  if (name === 'atoa_delegate_progress') {
    return run(['delegate', 'progress', '--task', input.task_id, '--message', input.message]);
  }
  if (name === 'atoa_delegate_cancel') {
    if (input.confirmed !== true) throw new Error('取消委派任务前必须确认');
    return run(['delegate', 'cancel', '--task', input.task_id, '--reason', input.reason, '--confirm']);
  }
  if (name === 'atoa_delegate_submit_result') {
    if (input.confirmed !== true) throw new Error('客户端候选结果必须在用户明确授权范围内');
    return run([
      'delegate', 'submit',
      '--task', input.task_id,
      '--base-revision', input.base_revision,
      ...(input.message ? ['--message', input.message] : []),
      ...(input.summary ? ['--summary', input.summary] : []),
      ...(input.reuse_candidate
        ? ['--reuse-candidate']
        : input.operations?.length
        ? ['--operations', JSON.stringify(input.operations)]
        : ['--files', JSON.stringify(input.files || [])]),
      '--evidence', JSON.stringify(input.evidence || {}),
      '--confirm'
    ]);
  }
  if (name === 'atoa_cloud_projects') return run(['cloud', 'list']);
  if (name === 'atoa_cloud_create_project') {
    if (input.confirmed !== true) throw new Error('创建持久化项目需要用户明确确认');
    return run(['cloud', 'create', '--id', input.id, '--name', input.name, '--description', input.description]);
  }
  if (name === 'atoa_cloud_add_project_skill') {
    if (input.confirmed !== true) throw new Error('添加项目 Skill 需要项目创建者明确确认');
    return run([
      'cloud', 'skill-add',
      '--project', input.project_id,
      '--id', input.id,
      '--name', input.name,
      '--description', input.description,
      '--instructions', input.instructions,
      '--triggers', JSON.stringify(input.triggers || [])
    ]);
  }
  if (name === 'atoa_cloud_add_project_member') {
    if (input.confirmed !== true) throw new Error('添加项目成员需要项目所有者明确确认');
    return run(['cloud', 'member-add', '--project', input.project_id, '--email', input.email]);
  }
  if (name === 'atoa_cloud_remove_project_member') {
    if (input.confirmed !== true) throw new Error('撤销项目成员权限需要项目所有者明确确认');
    return run(['cloud', 'member-remove', '--project', input.project_id, '--member', input.member_id, '--confirm']);
  }
  if (name === 'atoa_cloud_project') return run(['cloud', 'show', '--project', input.project_id]);
  if (name === 'atoa_cloud_read_file') return run(['cloud', 'read', '--project', input.project_id, '--path', input.path]);
  if (name === 'atoa_cloud_test') return run(['cloud', 'test', '--project', input.project_id]);
  if (name === 'atoa_cloud_history') return run(['cloud', 'history', '--project', input.project_id, '--limit', String(input.limit || 20)]);
  if (name === 'atoa_cloud_checkout') {
    const args = ['cloud', 'checkout', '--project', input.project_id];
    if (input.directory) args.push('--dir', input.directory);
    return run(args);
  }
  if (name === 'atoa_cloud_validate_worktree') {
    return run(['cloud', 'validate', '--worktree', input.directory]);
  }
  if (name === 'atoa_cloud_submit_worktree') {
    if (input.confirmed !== true) throw new Error('工作区变更必须在用户明确授权范围内');
    const args = ['cloud', 'submit', '--worktree', input.directory, '--message', input.message, '--confirm'];
    if (input.keep_worktree === true) args.push('--keep-worktree');
    return run(args);
  }
  if (name === 'atoa_cloud_cleanup_worktree') {
    if (input.confirmed !== true) throw new Error('必须确认准确的 ATOA 工作区目录后才能清理');
    return run(['cloud', 'cleanup', '--worktree', input.directory, '--confirm']);
  }
  if (name === 'atoa_cloud_submit_change') {
    if (input.confirmed !== true) throw new Error('代码变更必须在用户明确授权范围内');
    return run([
      'cloud', 'change',
      '--project', input.project_id,
      '--base-revision', input.base_revision,
      '--message', input.message,
      '--files', JSON.stringify(input.files),
      '--confirm'
    ]);
  }
  throw new Error(`未知工具：${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch { return; }
  if (request.method === 'notifications/initialized') return;
  try {
    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'atoa-codex', version: '2.3.0' },
          instructions: 'ATOA is only for collaborative coding. Send only the current authorized task content; never inspect or upload other Codex sessions, unrelated local files, environment variables, browser data, or credentials. Use server control-plane delegation: create a task; when it is queued, verify local worker handoff and end the current turn without polling. The on-demand client Worker starts a fresh local Agent after dispatch. Claim minimal Context, request more Context when needed, return a candidate, and let the deterministic server scan, validate, merge, deploy, and create the runnable Demo version. The server is not an Agent.'
        }
      });
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } });
    } else if (request.method === 'tools/call') {
      const text = await callTool(request.params?.name, request.params?.arguments || {});
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }] } });
    } else if (request.id !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } });
  }
});

spawnSync(CLI.command, [...CLI.prefix, 'skills', 'sync'], { env, stdio: 'ignore', timeout: 15000 });
