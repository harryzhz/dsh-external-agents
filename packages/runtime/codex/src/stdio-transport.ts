import { basename } from 'node:path'
import {
  StdioJsonRpcTransport,
  resolveSafeCwd,
} from '@dsh-external-agents/runtime-shared-stdio'
import type { CodexTransportFactoryOptions, JsonRpcTransport } from './types.js'

export { resolveSafeCwd }

export class CodexStdioTransport extends StdioJsonRpcTransport implements JsonRpcTransport {
  constructor(options: CodexTransportFactoryOptions) {
    super({
      command: options.cliBin,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      label: `${basename(options.cliBin) || 'codex'} app-server`,
      resolveCwd: true,
    })
  }
}
