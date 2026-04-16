import { createPublicClient, http, type Address } from 'viem';
import { bsc } from 'viem/chains';
import { abi } from './abi';

export type IdentityType = 'None' | 'Human' | 'Agent';
export type CheckResult = {
  status: 'match'|'mismatch'|'unverified'|'expired'|'no_id_given'|'type_mismatch',
  actualId: string,
  idType: IdentityType,
  riskLevel: 'safe'|'warn'|'danger'|'info',
  canProceed: boolean,
  message: string
};

export function createRegistry(rpcUrl = 'https://bsc-dataseed.binance.org', contractAddress: Address) {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  return {
    verify: async ({address, claimedId}: {address: Address, claimedId?: string}): Promise<CheckResult> => {
      if (!claimedId) {
        const [identifier, idType,, expired] = await client.readContract({
          address: contractAddress, abi, functionName: 'resolveAddress', args: [address]
        });
        if (!identifier) return { status: 'unverified', actualId: '', idType: 'None', riskLevel: 'warn', canProceed: false, message: '⚠️ No identifier linked. High risk' };
        return { status: 'no_id_given', actualId: identifier, idType, riskLevel: 'info', canProceed: true, message: `ℹ️ This address is ${identifier}. Confirm?` };
      }
      const [match, actualId, idType, expired] = await client.readContract({
        address: contractAddress, abi, functionName: 'verifyPair', args: [address, claimedId]
      });
      if (expired) return { status: 'expired', actualId, idType, riskLevel: 'danger', canProceed: false, message: '⛔ Identifier expired' };
      if (!match) return { status: 'mismatch', actualId, idType, riskLevel: 'danger', canProceed: false, message: `⛔ MISMATCH: Address belongs to ${actualId}` };
      if (claimedId.startsWith('@') && idType!== 1) return { status: 'type_mismatch', actualId, idType: 'Agent', riskLevel: 'danger', canProceed: false, message: '⛔ TYPE ERROR: Address is Agent but you entered @human' };
      if (claimedId.startsWith('#') && idType!== 2) return { status: 'type_mismatch', actualId, idType: 'Human', riskLevel: 'danger', canProceed: false, message: '⛔ TYPE ERROR: Address is Human but you entered #agent' };
      return { status: 'match', actualId, idType: idType === 1? 'Human' : 'Agent', riskLevel: 'safe', canProceed: true, message: `✅ Verified: ${actualId}` };
    }
  };
}
