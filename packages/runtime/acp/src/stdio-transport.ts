import {
  StdioJsonRpcTransport,
  stripSshSessionEnv,
} from '@dsh-external-agents/runtime-shared-stdio'
import type { AcpJsonRpcTransport, AcpTransportFactoryOptions } from './types.js'

export { stripSshSessionEnv }

export class AcpStdioTransport extends StdioJsonRpcTransport implements AcpJsonRpcTransport {
  constructor(options: AcpTransportFactoryOptions) {
    super({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      label: `acp(${options.command})`,
    })
  }
}
