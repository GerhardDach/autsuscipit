import type { AgentContext } from '@aries-framework/core'

import { Repository, InjectionSymbols, StorageService, EventEmitter, injectable, inject } from '@aries-framework/core'

import { AnonCredsLinkSecretRecord } from './AnonCredsLinkSecretRecord'

@injectable()
export class AnonCredsLinkSecretRepository extends Repository<AnonCredsLinkSecretRecord> {
  public constructor(
    @inject(InjectionSymbols.StorageService) storageService: StorageService<AnonCredsLinkSecretRecord>,
    eventEmitter: EventEmitter
  ) {
    super(AnonCredsLinkSecretRecord, storageService, eventEmitter)
  }

  public async getDefault(agentContext: AgentContext) {
    return this.getSingleByQuery(agentContext, { isDefault: true })
  }

  public async findDefault(agentContext: AgentContext) {
    return this.findSingleByQuery(agentContext, { isDefault: true })
  }

  public async getByLinkSecretId(agentContext: AgentContext, linkSecretId: string) {
    return this.getSingleByQuery(agentContext, { linkSecretId })
  }

  public async findByLinkSecretId(agentContext: AgentContext, linkSecretId: string) {
    return this.findSingleByQuery(agentContext, { linkSecretId })
  }
}
