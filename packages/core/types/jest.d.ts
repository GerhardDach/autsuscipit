import type { ConnectionRecord } from '../src/modules/connections/repository/ConnectionRecord'

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeConnectedWith(connection: ConnectionRecord): R
    }
  }
}
