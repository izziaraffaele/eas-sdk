import { expect } from 'chai';
import { BaseWallet } from 'ethers';
import {
  AttestationRequestData,
  EAS,
  MultiAttestationRequest,
  MultiDelegatedAttestationRequest,
  MultiDelegatedProxyAttestationRequest,
  MultiDelegatedProxyRevocationRequest,
  MultiDelegatedRevocationRequest,
  MultiRevocationRequest,
  NO_EXPIRATION,
  RevocationRequestData
} from '../../../src/eas';
import {
  EIP712AttestationParams,
  EIP712AttestationProxyParams,
  EIP712MessageTypes,
  EIP712Response,
  EIP712RevocationParams,
  EIP712RevocationProxyParams,
  OFFCHAIN_ATTESTATION_VERSION
} from '../../../src/offchain';
import { Transaction } from '../../../src/transaction';
import { getOffchainUID } from '../../../src/utils';
import { ZERO_BYTES, ZERO_BYTES32 } from '../../utils/Constants';
import { latest } from './time';

export enum SignatureType {
  Direct = 'direct',
  Delegated = 'delegated',
  DelegatedProxy = 'delegated-proxy',
  Offchain = 'offchain'
}

interface RequestOptions {
  signatureType?: SignatureType;
  deadline?: bigint;
  from: BaseWallet;
  value?: bigint;
  maxPriorityFeePerGas?: bigint | Promise<bigint>;
  maxFeePerGas?: bigint | Promise<bigint>;
}

export interface AttestationOptions extends RequestOptions {
  bump?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface RevocationOptions extends RequestOptions {}

export const expectAttestation = async (
  eas: EAS,
  schema: string,
  request: AttestationRequestData,
  options: AttestationOptions
) => {
  const {
    recipient,
    expirationTime = NO_EXPIRATION,
    revocable = true,
    refUID = ZERO_BYTES32,
    data = ZERO_BYTES,
    value = 0n
  } = request;
  const {
    from: txSender,
    signatureType = SignatureType.Direct,
    deadline = NO_EXPIRATION,
    maxPriorityFeePerGas,
    maxFeePerGas
  } = options;

  let uid;

  const overrides =
    maxPriorityFeePerGas && maxFeePerGas
      ? { maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(), maxFeePerGas: maxFeePerGas?.toString() }
      : undefined;
  let tx: Transaction<string> | undefined;

  switch (signatureType) {
    case SignatureType.Direct: {
      uid = await (
        await eas
          .connect(txSender)
          .attest({ schema, data: { recipient, expirationTime, revocable, refUID, data, value } }, overrides)
      ).wait();

      break;
    }

    case SignatureType.Delegated: {
      const delegated = await eas.getDelegated();
      const response = await delegated.signDelegatedAttestation(
        {
          schema,
          recipient,
          expirationTime,
          revocable,
          refUID,
          data,
          nonce: await eas.getNonce(txSender.address)
        },
        txSender
      );

      expect(await delegated.verifyDelegatedAttestationSignature(txSender.address, response)).to.be.true;

      tx = await eas.connect(txSender).attestByDelegation(
        {
          schema,
          data: { recipient, expirationTime, revocable, refUID, data, value },
          signature: response.signature,
          attester: txSender.address
        },
        overrides
      );
      uid = await tx.wait();

      break;
    }

    case SignatureType.DelegatedProxy: {
      const proxy = await eas.getEIP712Proxy();
      if (!proxy) {
        throw new Error('Invalid proxy');
      }
      const delegated = await proxy?.getDelegated();

      const response = await delegated.signDelegatedProxyAttestation(
        {
          schema,
          recipient,
          expirationTime,
          revocable,
          refUID,
          data,
          deadline
        },
        txSender
      );

      expect(await delegated.verifyDelegatedProxyAttestationSignature(txSender.address, response)).to.be.true;

      tx = await eas.connect(txSender).attestByDelegationProxy(
        {
          schema,
          data: { recipient, expirationTime, revocable, refUID, data, value },
          signature: response.signature,
          attester: txSender.address,
          deadline
        },
        overrides
      );

      uid = await tx.wait();

      expect(await eas.getEIP712Proxy()?.getAttester(uid)).to.equal(txSender.address);

      break;
    }

    case SignatureType.Offchain: {
      const offchain = await eas.getOffchain();

      const now = await latest();
      const uid = getOffchainUID(
        OFFCHAIN_ATTESTATION_VERSION,
        schema,
        recipient,
        now,
        expirationTime,
        revocable,
        refUID,
        data
      );
      const response = await offchain.signOffchainAttestation(
        {
          version: OFFCHAIN_ATTESTATION_VERSION,
          schema,
          recipient,
          time: now,
          expirationTime,
          revocable,
          refUID,
          data
        },
        txSender
      );

      expect(response.uid).to.equal(uid);
      expect(await offchain.verifyOffchainAttestationSignature(txSender.address, response)).to.be.true;

      return uid;
    }
  }

  expect(await eas.isAttestationValid(uid)).to.be.true;

  if (maxPriorityFeePerGas && maxFeePerGas && tx) {
    expect(tx.tx.maxPriorityFeePerGas).to.equal(maxPriorityFeePerGas);
    expect(tx.tx.maxFeePerGas).to.equal(maxFeePerGas);
  }

  return uid;
};

export const expectMultiAttestations = async (
  eas: EAS,
  requests: MultiAttestationRequest[],
  options: AttestationOptions
) => {
  const {
    from: txSender,
    signatureType = SignatureType.Direct,
    deadline = NO_EXPIRATION,
    maxPriorityFeePerGas,
    maxFeePerGas
  } = options;

  const overrides =
    maxPriorityFeePerGas && maxFeePerGas
      ? { maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(), maxFeePerGas: maxFeePerGas?.toString() }
      : undefined;

  let tx: Transaction<string[]> | undefined;
  let uids: string[] = [];

  switch (signatureType) {
    case SignatureType.Direct: {
      const tx = await eas.connect(txSender).multiAttest(requests);
      uids = await tx.wait();

      break;
    }

    case SignatureType.Delegated: {
      const multiDelegatedAttestationRequests: MultiDelegatedAttestationRequest[] = [];

      let nonce = await eas.getNonce(txSender.address);

      for (const { schema, data } of requests) {
        const responses: EIP712Response<EIP712MessageTypes, EIP712AttestationParams>[] = [];

        for (const request of data) {
          const delegated = await eas.getDelegated();
          const response = await delegated.signDelegatedAttestation(
            {
              schema,
              recipient: request.recipient,
              expirationTime: request.expirationTime ?? NO_EXPIRATION,
              revocable: request.revocable ?? true,
              refUID: request.refUID ?? ZERO_BYTES32,
              data: request.data,
              nonce
            },
            txSender
          );

          expect(await delegated.verifyDelegatedAttestationSignature(txSender.address, response)).to.be.true;

          responses.push(response);

          nonce++;
        }

        multiDelegatedAttestationRequests.push({
          schema,
          data,
          signatures: responses.map((r) => r.signature),
          attester: txSender.address
        });
      }

      tx = await eas.connect(txSender).multiAttestByDelegation(multiDelegatedAttestationRequests, overrides);
      uids = await tx.wait();

      break;
    }

    case SignatureType.DelegatedProxy: {
      const proxy = await eas.getEIP712Proxy();
      if (!proxy) {
        throw new Error('Invalid proxy');
      }
      const delegated = await proxy?.getDelegated();

      const multiDelegatedProxyAttestationRequests: MultiDelegatedProxyAttestationRequest[] = [];

      for (const { schema, data } of requests) {
        const responses: EIP712Response<EIP712MessageTypes, EIP712AttestationProxyParams>[] = [];

        for (const request of data) {
          const response = await delegated.signDelegatedProxyAttestation(
            {
              schema,
              recipient: request.recipient,
              expirationTime: request.expirationTime ?? NO_EXPIRATION,
              revocable: request.revocable ?? true,
              refUID: request.refUID ?? ZERO_BYTES32,
              data: request.data,
              deadline
            },
            txSender
          );

          expect(await delegated.verifyDelegatedProxyAttestationSignature(txSender.address, response)).to.be.true;

          responses.push(response);
        }

        multiDelegatedProxyAttestationRequests.push({
          schema,
          data,
          signatures: responses.map((r) => r.signature),
          attester: txSender.address,
          deadline
        });
      }

      tx = await eas.connect(txSender).multiAttestByDelegationProxy(multiDelegatedProxyAttestationRequests, overrides);
      uids = await tx.wait();

      for (const uid of uids) {
        expect(await eas.getEIP712Proxy()?.getAttester(uid)).to.equal(txSender.address);
      }

      break;
    }

    case SignatureType.Offchain: {
      throw new Error('Offchain batch attestations are unsupported');
    }
  }

  for (const uid of uids) {
    expect(await eas.isAttestationValid(uid)).to.be.true;
  }

  if (maxPriorityFeePerGas && maxFeePerGas && tx) {
    expect(tx.tx.maxPriorityFeePerGas).to.equal(maxPriorityFeePerGas);
    expect(tx.tx.maxFeePerGas).to.equal(maxFeePerGas);
  }
};

export const expectRevocation = async (
  eas: EAS,
  schema: string,
  request: RevocationRequestData,
  options: RevocationOptions
) => {
  const { uid, value = 0n } = request;
  const {
    from: txSender,
    signatureType = SignatureType.Direct,
    deadline = NO_EXPIRATION,

    maxPriorityFeePerGas,
    maxFeePerGas
  } = options;

  const overrides =
    maxPriorityFeePerGas && maxFeePerGas
      ? { maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(), maxFeePerGas: maxFeePerGas?.toString() }
      : undefined;
  let tx: Transaction<void> | undefined;

  switch (signatureType) {
    case SignatureType.Direct: {
      tx = await eas.connect(txSender).revoke({ schema, data: { uid, value } }, overrides);

      break;
    }

    case SignatureType.Delegated: {
      const delegated = await eas.getDelegated();
      const response = await delegated.signDelegatedRevocation(
        { schema, uid, nonce: await eas.getNonce(txSender.address) },
        txSender
      );

      expect(await delegated.verifyDelegatedRevocationSignature(txSender.address, response)).to.be.true;

      tx = await eas.connect(txSender).revokeByDelegation(
        {
          schema,
          data: { uid, value },
          signature: response.signature,
          revoker: txSender.address
        },
        overrides
      );

      break;
    }

    case SignatureType.DelegatedProxy: {
      const proxy = await eas.getEIP712Proxy();
      if (!proxy) {
        throw new Error('Invalid proxy');
      }
      const delegated = await proxy?.getDelegated();

      const response = await delegated.signDelegatedProxyRevocation({ schema, uid, deadline }, txSender);

      expect(await delegated.verifyDelegatedProxyRevocationSignature(txSender.address, response)).to.be.true;

      tx = await eas.connect(txSender).revokeByDelegationProxy(
        {
          schema,
          data: { uid, value },
          signature: response.signature,
          revoker: txSender.address,
          deadline
        },
        overrides
      );

      break;
    }
  }

  expect(await eas.isAttestationRevoked(uid)).to.be.true;

  if (maxPriorityFeePerGas && maxFeePerGas && tx) {
    expect(tx.tx.maxPriorityFeePerGas).to.equal(maxPriorityFeePerGas);
    expect(tx.tx.maxFeePerGas).to.equal(maxFeePerGas);
  }
};

export const expectMultiRevocations = async (
  eas: EAS,
  requests: MultiRevocationRequest[],
  options: RevocationOptions
) => {
  const {
    from: txSender,
    signatureType = SignatureType.Direct,
    deadline = NO_EXPIRATION,

    maxPriorityFeePerGas,
    maxFeePerGas
  } = options;

  const overrides =
    maxPriorityFeePerGas && maxFeePerGas
      ? { maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(), maxFeePerGas: maxFeePerGas?.toString() }
      : undefined;
  let tx: Transaction<void> | undefined;

  switch (signatureType) {
    case SignatureType.Direct: {
      await eas.connect(txSender).multiRevoke(requests);

      break;
    }

    case SignatureType.Delegated: {
      const multiDelegatedRevocationRequests: MultiDelegatedRevocationRequest[] = [];

      let nonce = await eas.getNonce(txSender.address);

      for (const { schema, data } of requests) {
        const responses: EIP712Response<EIP712MessageTypes, EIP712RevocationParams>[] = [];

        for (const request of data) {
          const delegated = await eas.getDelegated();
          const response = await delegated.signDelegatedRevocation({ schema, uid: request.uid, nonce }, txSender);

          expect(await delegated.verifyDelegatedRevocationSignature(txSender.address, response)).to.be.true;

          responses.push(response);

          nonce++;
        }

        multiDelegatedRevocationRequests.push({
          schema,
          data,
          signatures: responses.map((r) => r.signature),
          revoker: txSender.address
        });
      }

      tx = await eas.connect(txSender).multiRevokeByDelegation(multiDelegatedRevocationRequests, overrides);

      break;
    }

    case SignatureType.DelegatedProxy: {
      const proxy = await eas.getEIP712Proxy();
      if (!proxy) {
        throw new Error('Invalid proxy');
      }
      const delegated = await proxy?.getDelegated();

      const multiDelegatedProxyRevocationRequests: MultiDelegatedProxyRevocationRequest[] = [];

      for (const { schema, data } of requests) {
        const responses: EIP712Response<EIP712MessageTypes, EIP712RevocationProxyParams>[] = [];

        for (const request of data) {
          const response = await delegated.signDelegatedProxyRevocation(
            { schema, uid: request.uid, deadline },
            txSender
          );

          expect(await delegated.verifyDelegatedProxyRevocationSignature(txSender.address, response)).to.be.true;

          responses.push(response);
        }

        multiDelegatedProxyRevocationRequests.push({
          schema,
          data,
          signatures: responses.map((r) => r.signature),
          revoker: txSender.address,
          deadline
        });
      }

      tx = await eas.connect(txSender).multiRevokeByDelegationProxy(multiDelegatedProxyRevocationRequests, overrides);

      break;
    }
  }

  for (const data of requests) {
    for (const { uid } of data.data) {
      expect(await eas.isAttestationValid(uid)).to.be.true;
      expect(await eas.isAttestationRevoked(uid)).to.be.true;
    }
  }

  if (maxPriorityFeePerGas && maxFeePerGas && tx) {
    expect(tx.tx.maxPriorityFeePerGas).to.equal(maxPriorityFeePerGas);
    expect(tx.tx.maxFeePerGas).to.equal(maxFeePerGas);
  }
};
