import type { RpcObject } from './types'

export const MAX_RPC_WRITE_FRAME_BYTES = 2 * 1024 * 1024
const RPC_REQUEST_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

export function rpcRequestFrameBytes(command: RpcObject): number {
  return Buffer.byteLength(`${JSON.stringify({ ...command, id: RPC_REQUEST_ID_PLACEHOLDER })}
`, 'utf8')
}
