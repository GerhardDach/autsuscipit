import type {
  DifPexInputDescriptorToCredentials,
  DifPexCredentialsForRequest,
  DifPresentationExchangeDefinition,
  DifPresentationExchangeDefinitionV1,
  DifPresentationExchangeSubmission,
  DifPresentationExchangeDefinitionV2,
} from './models'
import type { AgentContext } from '../../agent'
import type { Query } from '../../storage/StorageService'
import type { VerificationMethod } from '../dids'
import type { W3cCredentialRecord, W3cVerifiableCredential, W3cVerifiablePresentation } from '../vc'
import type { PresentationSignCallBackParams, Validated, VerifiablePresentationResult } from '@sphereon/pex'
import type { InputDescriptorV2, PresentationDefinitionV1 } from '@sphereon/pex-models'
import type { OriginalVerifiableCredential, OriginalVerifiablePresentation } from '@sphereon/ssi-types'

import { Status, PEVersion, PEX } from '@sphereon/pex'
import { injectable } from 'tsyringe'

import { getJwkFromKey } from '../../crypto'
import { AriesFrameworkError } from '../../error'
import { JsonTransformer } from '../../utils'
import { DidsApi, getKeyFromVerificationMethod } from '../dids'
import {
  ClaimFormat,
  SignatureSuiteRegistry,
  W3cCredentialRepository,
  W3cCredentialService,
  W3cPresentation,
} from '../vc'

import { DifPresentationExchangeError } from './DifPresentationExchangeError'
import { DifPresentationExchangeSubmissionLocation } from './models'
import {
  getCredentialsForRequest,
  getSphereonOriginalVerifiableCredential,
  getSphereonW3cVerifiablePresentation,
  getW3cVerifiablePresentationInstance,
} from './utils'

export type ProofStructure = Record<string, Record<string, Array<W3cVerifiableCredential>>>

@injectable()
export class DifPresentationExchangeService {
  private pex = new PEX()

  public async getCredentialsForRequest(
    agentContext: AgentContext,
    presentationDefinition: DifPresentationExchangeDefinition
  ): Promise<DifPexCredentialsForRequest> {
    const credentialRecords = await this.queryCredentialForPresentationDefinition(agentContext, presentationDefinition)

    // FIXME: why are we resolving all created dids here?
    // If we want to do this we should extract all dids from the credential records and only
    // fetch the dids for the queried credential records
    const didsApi = agentContext.dependencyManager.resolve(DidsApi)
    const didRecords = await didsApi.getCreatedDids()
    const holderDids = didRecords.map((didRecord) => didRecord.did)

    return getCredentialsForRequest(presentationDefinition, credentialRecords, holderDids)
  }

  /**
   * Selects the credentials to use based on the output from `getCredentialsForRequest`
   * Use this method if you don't want to manually select the credentials yourself.
   */
  public selectCredentialsForRequest(
    credentialsForRequest: DifPexCredentialsForRequest
  ): DifPexInputDescriptorToCredentials {
    if (!credentialsForRequest.areRequirementsSatisfied) {
      throw new AriesFrameworkError('Could not find the required credentials for the presentation submission')
    }

    const credentials: DifPexInputDescriptorToCredentials = {}

    for (const requirement of credentialsForRequest.requirements) {
      for (const submission of requirement.submissionEntry) {
        if (!credentials[submission.inputDescriptorId]) {
          credentials[submission.inputDescriptorId] = []
        }

        // We pick the first matching VC if we are auto-selecting
        credentials[submission.inputDescriptorId].push(submission.verifiableCredentials[0].credential)
      }
    }

    return credentials
  }

  public validatePresentationDefinition(presentationDefinition: DifPresentationExchangeDefinition) {
    const validation = PEX.validateDefinition(presentationDefinition)
    const errorMessages = this.formatValidated(validation)
    if (errorMessages.length > 0) {
      throw new DifPresentationExchangeError(`Invalid presentation definition`, { additionalMessages: errorMessages })
    }
  }

  public validatePresentationSubmission(presentationSubmission: DifPresentationExchangeSubmission) {
    const validation = PEX.validateSubmission(presentationSubmission)
    const errorMessages = this.formatValidated(validation)
    if (errorMessages.length > 0) {
      throw new DifPresentationExchangeError(`Invalid presentation submission`, { additionalMessages: errorMessages })
    }
  }

  public validatePresentation(
    presentationDefinition: DifPresentationExchangeDefinition,
    presentation: W3cVerifiablePresentation
  ) {
    const { errors } = this.pex.evaluatePresentation(
      presentationDefinition,
      presentation.encoded as OriginalVerifiablePresentation
    )

    if (errors) {
      const errorMessages = this.formatValidated(errors as Validated)
      if (errorMessages.length > 0) {
        throw new DifPresentationExchangeError(`Invalid presentation`, { additionalMessages: errorMessages })
      }
    }
  }

  private formatValidated(v: Validated) {
    const validated = Array.isArray(v) ? v : [v]
    return validated
      .filter((r) => r.tag === Status.ERROR)
      .map((r) => r.message)
      .filter((r): r is string => Boolean(r))
  }

  /**
   * Queries the wallet for credentials that match the given presentation definition. This only does an initial query based on the
   * schema of the input descriptors. It does not do any further filtering based on the constraints in the input descriptors.
   */
  private async queryCredentialForPresentationDefinition(
    agentContext: AgentContext,
    presentationDefinition: DifPresentationExchangeDefinition
  ): Promise<Array<W3cCredentialRecord>> {
    const w3cCredentialRepository = agentContext.dependencyManager.resolve(W3cCredentialRepository)
    const query: Array<Query<W3cCredentialRecord>> = []
    const presentationDefinitionVersion = PEX.definitionVersionDiscovery(presentationDefinition)

    if (!presentationDefinitionVersion.version) {
      throw new DifPresentationExchangeError(
        `Unable to determine the Presentation Exchange version from the presentation definition
        `,
        presentationDefinitionVersion.error ? { additionalMessages: [presentationDefinitionVersion.error] } : {}
      )
    }

    if (presentationDefinitionVersion.version === PEVersion.v1) {
      const pd = presentationDefinition as PresentationDefinitionV1

      // The schema.uri can contain either an expanded type, or a context uri
      for (const inputDescriptor of pd.input_descriptors) {
        for (const schema of inputDescriptor.schema) {
          query.push({
            $or: [{ expandedType: [schema.uri] }, { contexts: [schema.uri] }, { type: [schema.uri] }],
          })
        }
      }
    } else if (presentationDefinitionVersion.version === PEVersion.v2) {
      // FIXME: As PE version 2 does not have the `schema` anymore, we can't query by schema anymore.
      // For now we retrieve ALL credentials, as we did the same for V1 with JWT credentials. We probably need
      // to find some way to do initial filtering, hopefully if there's a filter on the `type` field or something.
    } else {
      throw new DifPresentationExchangeError(
        `Unsupported presentation definition version ${presentationDefinitionVersion.version as unknown as string}`
      )
    }

    // query the wallet ourselves first to avoid the need to query the pex library for all
    // credentials for every proof request
    const credentialRecords =
      query.length > 0
        ? await w3cCredentialRepository.findByQuery(agentContext, {
            $or: query,
          })
        : await w3cCredentialRepository.getAll(agentContext)

    return credentialRecords
  }

  private addCredentialToSubjectInputDescriptor(
    subjectsToInputDescriptors: ProofStructure,
    subjectId: string,
    inputDescriptorId: string,
    credential: W3cVerifiableCredential
  ) {
    const inputDescriptorsToCredentials = subjectsToInputDescriptors[subjectId] ?? {}
    const credentials = inputDescriptorsToCredentials[inputDescriptorId] ?? []

    credentials.push(credential)
    inputDescriptorsToCredentials[inputDescriptorId] = credentials
    subjectsToInputDescriptors[subjectId] = inputDescriptorsToCredentials
  }

  private getPresentationFormat(
    presentationDefinition: DifPresentationExchangeDefinition,
    credentials: Array<OriginalVerifiableCredential>
  ): ClaimFormat.JwtVp | ClaimFormat.LdpVp {
    const allCredentialsAreJwtVc = credentials?.every((c) => typeof c === 'string')
    const allCredentialsAreLdpVc = credentials?.every((c) => typeof c !== 'string')

    const inputDescriptorsNotSupportingJwtVc = (
      presentationDefinition.input_descriptors as Array<InputDescriptorV2>
    ).filter((d) => d.format && d.format.jwt_vc === undefined)

    const inputDescriptorsNotSupportingLdpVc = (
      presentationDefinition.input_descriptors as Array<InputDescriptorV2>
    ).filter((d) => d.format && d.format.ldp_vc === undefined)

    if (
      allCredentialsAreJwtVc &&
      (presentationDefinition.format === undefined || presentationDefinition.format.jwt_vc) &&
      inputDescriptorsNotSupportingJwtVc.length === 0
    ) {
      return ClaimFormat.JwtVp
    } else if (
      allCredentialsAreLdpVc &&
      (presentationDefinition.format === undefined || presentationDefinition.format.ldp_vc) &&
      inputDescriptorsNotSupportingLdpVc.length === 0
    ) {
      return ClaimFormat.LdpVp
    } else {
      throw new DifPresentationExchangeError(
        'No suitable presentation format found for the given presentation definition, and credentials'
      )
    }
  }

  public async createPresentation(
    agentContext: AgentContext,
    options: {
      credentialsForInputDescriptor: DifPexInputDescriptorToCredentials
      presentationDefinition: DifPresentationExchangeDefinition
      /**
       * Defaults to {@link DifPresentationExchangeSubmissionLocation.PRESENTATION}
       */
      presentationSubmissionLocation?: DifPresentationExchangeSubmissionLocation
      challenge?: string
      domain?: string
      nonce?: string
    }
  ) {
    const { presentationDefinition, challenge, nonce, domain, presentationSubmissionLocation } = options

    const proofStructure: ProofStructure = {}

    Object.entries(options.credentialsForInputDescriptor).forEach(([inputDescriptorId, credentials]) => {
      credentials.forEach((credential) => {
        const subjectId = credential.credentialSubjectIds[0]
        if (!subjectId) {
          throw new DifPresentationExchangeError('Missing required credential subject for creating the presentation.')
        }

        this.addCredentialToSubjectInputDescriptor(proofStructure, subjectId, inputDescriptorId, credential)
      })
    })

    const verifiablePresentationResultsWithFormat: Array<{
      verifiablePresentationResult: VerifiablePresentationResult
      format: ClaimFormat.LdpVp | ClaimFormat.JwtVp
    }> = []

    const subjectToInputDescriptors = Object.entries(proofStructure)
    for (const [subjectId, subjectInputDescriptorsToCredentials] of subjectToInputDescriptors) {
      // Determine a suitable verification method for the presentation
      const verificationMethod = await this.getVerificationMethodForSubjectId(agentContext, subjectId)

      if (!verificationMethod) {
        throw new DifPresentationExchangeError(`No verification method found for subject id '${subjectId}'.`)
      }

      // We create a presentation for each subject
      // Thus for each subject we need to filter all the related input descriptors and credentials
      // FIXME: cast to V1, as tsc errors for strange reasons if not
      const inputDescriptorsForSubject = (presentationDefinition as PresentationDefinitionV1).input_descriptors.filter(
        (inputDescriptor) => inputDescriptor.id in subjectInputDescriptorsToCredentials
      )

      // Get all the credentials associated with the input descriptors
      const credentialsForSubject = Object.values(subjectInputDescriptorsToCredentials)
        .flat()
        .map(getSphereonOriginalVerifiableCredential)

      const presentationDefinitionForSubject: DifPresentationExchangeDefinition = {
        ...presentationDefinition,
        input_descriptors: inputDescriptorsForSubject,

        // We remove the submission requirements, as it will otherwise fail to create the VP
        submission_requirements: undefined,
      }

      const format = this.getPresentationFormat(presentationDefinitionForSubject, credentialsForSubject)

      // FIXME: Q1: is holder always subject id, what if there are multiple subjects???
      // FIXME: Q2: What about proofType, proofPurpose verification method for multiple subjects?
      const verifiablePresentationResult = await this.pex.verifiablePresentationFrom(
        presentationDefinitionForSubject,
        credentialsForSubject,
        this.getPresentationSignCallback(agentContext, verificationMethod, format),
        {
          holderDID: subjectId,
          proofOptions: { challenge, domain, nonce },
          signatureOptions: { verificationMethod: verificationMethod?.id },
          presentationSubmissionLocation:
            presentationSubmissionLocation ?? DifPresentationExchangeSubmissionLocation.PRESENTATION,
        }
      )

      verifiablePresentationResultsWithFormat.push({ verifiablePresentationResult, format })
    }

    if (!verifiablePresentationResultsWithFormat[0]) {
      throw new DifPresentationExchangeError('No verifiable presentations created')
    }

    if (subjectToInputDescriptors.length !== verifiablePresentationResultsWithFormat.length) {
      throw new DifPresentationExchangeError('Invalid amount of verifiable presentations created')
    }

    const presentationSubmission: DifPresentationExchangeSubmission = {
      id: verifiablePresentationResultsWithFormat[0].verifiablePresentationResult.presentationSubmission.id,
      definition_id:
        verifiablePresentationResultsWithFormat[0].verifiablePresentationResult.presentationSubmission.definition_id,
      descriptor_map: [],
    }

    for (const vpf of verifiablePresentationResultsWithFormat) {
      const { verifiablePresentationResult } = vpf
      presentationSubmission.descriptor_map.push(...verifiablePresentationResult.presentationSubmission.descriptor_map)
    }

    return {
      verifiablePresentations: verifiablePresentationResultsWithFormat.map((r) =>
        getW3cVerifiablePresentationInstance(r.verifiablePresentationResult.verifiablePresentation)
      ),
      presentationSubmission,
      presentationSubmissionLocation:
        verifiablePresentationResultsWithFormat[0].verifiablePresentationResult.presentationSubmissionLocation,
    }
  }

  private getSigningAlgorithmFromVerificationMethod(
    verificationMethod: VerificationMethod,
    suitableAlgorithms?: Array<string>
  ) {
    const key = getKeyFromVerificationMethod(verificationMethod)
    const jwk = getJwkFromKey(key)

    if (suitableAlgorithms) {
      const possibleAlgorithms = jwk.supportedSignatureAlgorithms.filter((alg) => suitableAlgorithms?.includes(alg))
      if (!possibleAlgorithms || possibleAlgorithms.length === 0) {
        throw new DifPresentationExchangeError(
          [
            `Found no suitable signing algorithm.`,
            `Algorithms supported by Verification method: ${jwk.supportedSignatureAlgorithms.join(', ')}`,
            `Suitable algorithms: ${suitableAlgorithms.join(', ')}`,
          ].join('\n')
        )
      }
    }

    const alg = jwk.supportedSignatureAlgorithms[0]
    if (!alg) throw new DifPresentationExchangeError(`No supported algs for key type: ${key.keyType}`)
    return alg
  }

  private getSigningAlgorithmsForPresentationDefinitionAndInputDescriptors(
    algorithmsSatisfyingDefinition: Array<string>,
    inputDescriptorAlgorithms: Array<Array<string>>
  ) {
    const allDescriptorAlgorithms = inputDescriptorAlgorithms.flat()
    const algorithmsSatisfyingDescriptors = allDescriptorAlgorithms.filter((alg) =>
      inputDescriptorAlgorithms.every((descriptorAlgorithmSet) => descriptorAlgorithmSet.includes(alg))
    )

    const algorithmsSatisfyingPdAndDescriptorRestrictions = algorithmsSatisfyingDefinition.filter((alg) =>
      algorithmsSatisfyingDescriptors.includes(alg)
    )

    if (
      algorithmsSatisfyingDefinition.length > 0 &&
      algorithmsSatisfyingDescriptors.length > 0 &&
      algorithmsSatisfyingPdAndDescriptorRestrictions.length === 0
    ) {
      throw new DifPresentationExchangeError(
        `No signature algorithm found for satisfying restrictions of the presentation definition and input descriptors`
      )
    }

    if (allDescriptorAlgorithms.length > 0 && algorithmsSatisfyingDescriptors.length === 0) {
      throw new DifPresentationExchangeError(
        `No signature algorithm found for satisfying restrictions of the input descriptors`
      )
    }

    let suitableAlgorithms: Array<string> | undefined
    if (algorithmsSatisfyingPdAndDescriptorRestrictions.length > 0) {
      suitableAlgorithms = algorithmsSatisfyingPdAndDescriptorRestrictions
    } else if (algorithmsSatisfyingDescriptors.length > 0) {
      suitableAlgorithms = algorithmsSatisfyingDescriptors
    } else if (algorithmsSatisfyingDefinition.length > 0) {
      suitableAlgorithms = algorithmsSatisfyingDefinition
    }

    return suitableAlgorithms
  }

  private getSigningAlgorithmForJwtVc(
    presentationDefinition: DifPresentationExchangeDefinitionV1 | DifPresentationExchangeDefinitionV2,
    verificationMethod: VerificationMethod
  ) {
    const algorithmsSatisfyingDefinition = presentationDefinition.format?.jwt_vc?.alg ?? []

    const inputDescriptorAlgorithms: Array<Array<string>> = presentationDefinition.input_descriptors
      .map((descriptor) => (descriptor as InputDescriptorV2).format?.jwt_vc?.alg ?? [])
      .filter((alg) => alg.length > 0)

    const suitableAlgorithms = this.getSigningAlgorithmsForPresentationDefinitionAndInputDescriptors(
      algorithmsSatisfyingDefinition,
      inputDescriptorAlgorithms
    )

    return this.getSigningAlgorithmFromVerificationMethod(verificationMethod, suitableAlgorithms)
  }

  private getProofTypeForLdpVc(
    agentContext: AgentContext,
    presentationDefinition: DifPresentationExchangeDefinitionV1 | DifPresentationExchangeDefinitionV2,
    verificationMethod: VerificationMethod
  ) {
    const algorithmsSatisfyingDefinition = presentationDefinition.format?.ldp_vc?.proof_type ?? []

    const inputDescriptorAlgorithms: Array<Array<string>> = presentationDefinition.input_descriptors
      .map((descriptor) => (descriptor as InputDescriptorV2).format?.ldp_vc?.proof_type ?? [])
      .filter((alg) => alg.length > 0)

    const suitableSignatureSuites = this.getSigningAlgorithmsForPresentationDefinitionAndInputDescriptors(
      algorithmsSatisfyingDefinition,
      inputDescriptorAlgorithms
    )

    // For each of the supported algs, find the key types, then find the proof types
    const signatureSuiteRegistry = agentContext.dependencyManager.resolve(SignatureSuiteRegistry)

    const supportedSignatureSuite = signatureSuiteRegistry.getByVerificationMethodType(verificationMethod.type)
    if (!supportedSignatureSuite) {
      throw new DifPresentationExchangeError(
        `Couldn't find a supported signature suite for the given verification method type '${verificationMethod.type}'`
      )
    }

    if (suitableSignatureSuites) {
      if (suitableSignatureSuites.includes(supportedSignatureSuite.proofType) === false) {
        throw new DifPresentationExchangeError(
          [
            'No possible signature suite found for the given verification method.',
            `Verification method type: ${verificationMethod.type}`,
            `SupportedSignatureSuite '${supportedSignatureSuite.proofType}'`,
            `SuitableSignatureSuites: ${suitableSignatureSuites.join(', ')}`,
          ].join('\n')
        )
      }

      return supportedSignatureSuite.proofType
    }

    return supportedSignatureSuite.proofType
  }

  public getPresentationSignCallback(
    agentContext: AgentContext,
    verificationMethod: VerificationMethod,
    vpFormat: ClaimFormat.LdpVp | ClaimFormat.JwtVp
  ) {
    const w3cCredentialService = agentContext.dependencyManager.resolve(W3cCredentialService)

    return async (callBackParams: PresentationSignCallBackParams) => {
      // The created partial proof and presentation, as well as original supplied options
      const { presentation: presentationJson, options, presentationDefinition } = callBackParams
      const { challenge, domain, nonce } = options.proofOptions ?? {}
      const { verificationMethod: verificationMethodId } = options.signatureOptions ?? {}

      if (verificationMethodId && verificationMethodId !== verificationMethod.id) {
        throw new DifPresentationExchangeError(
          `Verification method from signing options ${verificationMethodId} does not match verification method ${verificationMethod.id}`
        )
      }

      let signedPresentation: W3cVerifiablePresentation<ClaimFormat.JwtVp | ClaimFormat.LdpVp>
      if (vpFormat === 'jwt_vp') {
        signedPresentation = await w3cCredentialService.signPresentation(agentContext, {
          format: ClaimFormat.JwtVp,
          alg: this.getSigningAlgorithmForJwtVc(presentationDefinition, verificationMethod),
          verificationMethod: verificationMethod.id,
          presentation: JsonTransformer.fromJSON(presentationJson, W3cPresentation),
          challenge: challenge ?? nonce ?? (await agentContext.wallet.generateNonce()),
          domain,
        })
      } else if (vpFormat === 'ldp_vp') {
        signedPresentation = await w3cCredentialService.signPresentation(agentContext, {
          format: ClaimFormat.LdpVp,
          proofType: this.getProofTypeForLdpVc(agentContext, presentationDefinition, verificationMethod),
          proofPurpose: 'authentication',
          verificationMethod: verificationMethod.id,
          presentation: JsonTransformer.fromJSON(presentationJson, W3cPresentation),
          challenge: challenge ?? nonce ?? (await agentContext.wallet.generateNonce()),
          domain,
        })
      } else {
        throw new DifPresentationExchangeError(
          `Only JWT credentials or JSONLD credentials are supported for a single presentation`
        )
      }

      return getSphereonW3cVerifiablePresentation(signedPresentation)
    }
  }

  private async getVerificationMethodForSubjectId(agentContext: AgentContext, subjectId: string) {
    const didsApi = agentContext.dependencyManager.resolve(DidsApi)

    if (!subjectId.startsWith('did:')) {
      throw new DifPresentationExchangeError(
        `Only dids are supported as credentialSubject id. ${subjectId} is not a valid did`
      )
    }

    const didDocument = await didsApi.resolveDidDocument(subjectId)

    if (!didDocument.authentication || didDocument.authentication.length === 0) {
      throw new DifPresentationExchangeError(
        `No authentication verificationMethods found for did ${subjectId} in did document`
      )
    }

    // the signature suite to use for the presentation is dependant on the credentials we share.
    // 1. Get the verification method for this given proof purpose in this DID document
    let [verificationMethod] = didDocument.authentication
    if (typeof verificationMethod === 'string') {
      verificationMethod = didDocument.dereferenceKey(verificationMethod, ['authentication'])
    }

    return verificationMethod
  }
}
