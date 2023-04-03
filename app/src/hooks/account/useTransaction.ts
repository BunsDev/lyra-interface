import { ErrorDescription } from '@ethersproject/abi/lib/interface'
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from '@ethersproject/providers'
import { IconType } from '@lyra/ui/components/Icon'
import { closeToast, createPendingToast, updatePendingToast, updateToast } from '@lyra/ui/components/Toast'
import { BigNumber, Contract, ContractReceipt, PopulatedTransaction } from 'ethers'
import { useCallback } from 'react'

import { AppNetwork, Network } from '@/app/constants/networks'
import { TransactionType } from '@/app/constants/screen'
import getExplorerUrl from '@/app/utils/getExplorerUrl'
import getNetworkConfig from '@/app/utils/getNetworkConfig'
import getProvider from '@/app/utils/getProvider'
import postTransactionError from '@/app/utils/postTransactionError'
import postTransactionSuccess from '@/app/utils/postTransactionSuccess'
import resolveNetwork from '@/app/utils/resolveNetwork'

import useWallet from './useWallet'

const DEFAULT_TOAST_INFO_TIMEOUT = 1000 * 5 // 5 seconds
const DEFAULT_TOAST_ERROR_TIMEOUT = 1000 * 10 // 10 seconds
const POLL_INTERVAL = 250 // 0.25 seconds

enum TransactionErrorReason {
  NotEnoughFunds = 'NotEnoughFunds',
  UserDenied = 'UserDenied',
  NetworkChanged = 'NetworkChanged',
  RpcError = 'RpcError',
  TradeSlippage = 'TradeSlippage',
}

// https://docs.ethers.io/v5/single-page/#/v5/api/providers/types/-%23-providers-TransactionReceipt
enum TransactionStatus {
  Failure = 0,
  Success = 1,
}

enum TransactionErrorStage {
  GasEstimate = 'GasEstimate',
  Wallet = 'Wallet',
  Reverted = 'Reverted',
}

// Catches common error patterns
const TX_ERROR_PATTERNS: Record<TransactionErrorReason, { message?: string; code?: number | string; name?: string }[]> =
  {
    [TransactionErrorReason.TradeSlippage]: [{ name: 'TotalCostOutsideOfSpecifiedBounds' }],
    [TransactionErrorReason.UserDenied]: [
      { message: 'User denied transaction signature' },
      { message: 'User rejected transaction' },
      { message: "Cannot set properties of undefined (setting 'loadingDefaults')" },
      { code: 'ACTION_REJECTED' },
      { code: 4001 },
    ],
    [TransactionErrorReason.NotEnoughFunds]: [
      { message: 'Not enough funds for gas' },
      { message: 'Failed to execute call with revert code InsufficientGasFunds' },
    ],
    [TransactionErrorReason.NetworkChanged]: [{ message: 'Underlying network changed' }],
    [TransactionErrorReason.RpcError]: [
      // @see https://eips.ethereum.org/EIPS/eip-1474#error-codes
      { code: -32005 },
      { message: 'Non-200 status code' },
      { message: 'Request limit exceeded' },
      { message: 'Internal json-rpc error' },
      { message: 'Response has no error or result' },
      { message: "We can't execute this request" },
      { message: "Couldn't connect to the network" },
    ],
  }

type Value = string | number | boolean

type TransactionMetadata = Record<string, Value | Record<string, Value> | Array<Record<string, Value>>>

export type TransactionSuccessOptions = {
  network: Network
  toastId: string
  txName: TransactionType
  signer: string
  metadata?: TransactionMetadata
}

export type TransactionErrorOptions = {
  network: Network
  stage: TransactionErrorStage
  toastId: string
  txName: TransactionType
  signer: string
  receipt?: ContractReceipt
  handler?: TransactionErrorHandler
  contract?: Contract
  metadata?: TransactionMetadata
}

export type TransactionError = {
  code?: number
  message?: string
  data?: any
  description?: ErrorDescription | null
  reason?: TransactionErrorReason
}

export type Transaction<
  C extends Contract = Contract,
  M extends keyof Contract['functions'] & string = string,
  P extends Parameters<C['functions'][M]> = any
> =
  | PopulatedTransaction
  | {
      tx: PopulatedTransaction
      contract?: C
      metadata?: TransactionMetadata
    }
  | {
      contract: C
      method: M
      params: P
      options?: { gasLimit?: BigNumber }
      metadata?: TransactionMetadata
    }

export type TransactionErrorHandler = (error: TransactionError, rawError: any, receipt?: ContractReceipt) => any

export type TransactionOptions = {
  onComplete?: (receipt: ContractReceipt) => any
  onError?: TransactionErrorHandler
  metadata?: TransactionMetadata
}

const extractError = (rawError: any, options: TransactionErrorOptions): TransactionError => {
  const error = rawError?.error?.error ?? rawError?.error ?? rawError
  const errorCode = error?.code
  const errorData = error?.data?.data ?? error?.data

  let errorDescription: ErrorDescription | null = null
  if (errorData && options['contract']) {
    try {
      errorDescription = options['contract'].interface.parseError(errorData)
      console.log({ errorDescription })
    } catch (_err) {}
  }

  const errorMessage = error?.message

  for (const [reason, patterns] of Object.entries(TX_ERROR_PATTERNS)) {
    for (const pattern of patterns) {
      const matchCode = pattern.code && errorCode === pattern.code
      const matchMessage =
        pattern.message && errorMessage && errorMessage.toLowerCase().includes(pattern.message.toLowerCase())
      const matchName =
        pattern.name && errorDescription && errorDescription.name.toLowerCase().includes(pattern.name.toLowerCase())
      if (matchCode || matchMessage || matchName) {
        return {
          code: errorCode,
          message: errorMessage,
          data: errorData,
          description: errorDescription,
          reason: reason as TransactionErrorReason,
        }
      }
    }
  }

  return {
    code: errorCode,
    message: errorMessage,
    data: errorData,
    description: errorDescription,
  }
}

// Render custom errors
const formatErrorReason = (errorReason: TransactionErrorReason, options: TransactionErrorOptions): string | null => {
  switch (errorReason) {
    case TransactionErrorReason.TradeSlippage:
      return 'The quoted option price is now out of bounds, try again'
    case TransactionErrorReason.NetworkChanged:
      return 'Your network unexpectedly changed, try again'
    case TransactionErrorReason.RpcError:
      return 'An RPC error occurred, try again'
    case TransactionErrorReason.NotEnoughFunds:
      return `Your account on ${getNetworkConfig(options.network).displayName} doesn\'t have enough gas`
    case TransactionErrorReason.UserDenied:
      return null
  }
}

const handleError = (rawError: any, options: TransactionErrorOptions) => {
  const { handler, network, toastId, receipt } = options

  const error = extractError(rawError, options)
  const errorReasonMessage = error.reason
    ? formatErrorReason(error.reason, options)
    : options.stage === TransactionErrorStage.Reverted
    ? 'Transaction reverted'
    : 'Failed to send transaction'

  if (!errorReasonMessage) {
    // Ignore the transaction if no error reason is returned (e.g for denied transaction)
    closeToast(toastId)
    return
  }

  console.error(rawError)

  // Post transaction error to db
  postTransactionError(error, options)

  const txHash = receipt?.transactionHash

  updateToast(toastId, {
    variant: 'error',
    description: errorReasonMessage,
    icon: IconType.AlertTriangle,
    href: txHash ? getExplorerUrl(network, txHash) : undefined,
    target: '_blank',
    autoClose: DEFAULT_TOAST_ERROR_TIMEOUT,
  })

  if (handler) {
    handler(error, rawError, receipt)
  }
}

const getTimeout = (network: Network): number => {
  switch (resolveNetwork(network)) {
    case AppNetwork.Arbitrum:
    case AppNetwork.Optimism:
      return 10 * 1000
    case AppNetwork.Ethereum:
      return 60 * 1000
  }
}

async function getRawTxGasLimit(
  network: Network,
  provider: JsonRpcProvider,
  tx: PopulatedTransaction
): Promise<BigNumber> {
  const config = getNetworkConfig(network)
  const gasLimit = tx.gasLimit ?? (await provider.estimateGas(tx)).mul(10000 * Math.max(1, config.gasBuffer)).div(10000)
  if (gasLimit.lt(config.minGas)) {
    return config.minGas
  }
  if (gasLimit.gt(config.maxGas)) {
    return config.maxGas
  }
  return gasLimit
}

async function getContractTxGasLimit(
  network: Network,
  contract: Contract,
  method: string,
  params: any,
  options?: { gasLimit?: BigNumber }
): Promise<BigNumber> {
  const config = getNetworkConfig(network)
  const gasLimit =
    options?.gasLimit ??
    (await contract.estimateGas[method](...params)).mul(10000 * Math.max(1, config.gasBuffer)).div(10000)
  if (gasLimit.lt(config.minGas)) {
    return config.minGas
  }
  if (gasLimit.gt(config.maxGas)) {
    return config.maxGas
  }
  return gasLimit
}

export default function useTransaction(network: Network) {
  const { account, signer } = useWallet()

  return useCallback(
    async <
      C extends Contract = Contract,
      M extends keyof Contract['functions'] & string = string,
      P extends Parameters<C['functions'][M]> = any
    >(
      txInputs: Transaction<C, M, P>,
      txName: TransactionType,
      options?: TransactionOptions
    ): Promise<ContractReceipt | null> => {
      const provider = getProvider(network)

      const onComplete = options?.onComplete
      const onError = options?.onError

      if (!signer || !account) {
        console.warn('No signer')
        return null
      }

      const toastId = createPendingToast({
        description: 'Confirm your transaction',
        autoClose: false,
      })

      const successOrErrorOptions = {
        network,
        toastId,
        txName,
        metadata: options?.metadata,
        signer: account,
        handler: onError,
      }

      let response: TransactionResponse
      let contract: Contract | undefined
      let metadata: TransactionMetadata | undefined

      if ('method' in txInputs) {
        const method = txInputs['method']
        const params = txInputs['params']
        const options = txInputs['options']
        contract = txInputs['contract'].connect(signer)
        metadata = txInputs['metadata']

        let gasLimit: BigNumber
        try {
          gasLimit = await getContractTxGasLimit(network, contract, method, params, options)
        } catch (rawError) {
          handleError(rawError, {
            ...successOrErrorOptions,
            metadata,
            contract,
            stage: TransactionErrorStage.GasEstimate,
          })
          return null
        }

        try {
          response = await contract[method](...params, { gasLimit })
        } catch (rawError) {
          handleError(rawError, { ...successOrErrorOptions, metadata, contract, stage: TransactionErrorStage.Wallet })
          return null
        }
      } else {
        let tx: PopulatedTransaction
        if ('tx' in txInputs) {
          tx = txInputs['tx']
          metadata = txInputs['metadata']
          contract = txInputs['contract']?.connect(signer)
        } else {
          tx = txInputs
        }

        try {
          tx.gasLimit = await getRawTxGasLimit(network, provider, tx)
        } catch (rawError) {
          handleError(rawError, {
            ...successOrErrorOptions,
            metadata,
            contract,
            stage: TransactionErrorStage.GasEstimate,
          })
          return null
        }

        try {
          response = await signer.sendTransaction(tx)
        } catch (rawError) {
          handleError(rawError, { ...successOrErrorOptions, metadata, contract, stage: TransactionErrorStage.Wallet })
          return null
        }
      }

      const transactionTimeout = getTimeout(network)
      const autoClose = transactionTimeout + POLL_INTERVAL // add buffer
      const txHref = getExplorerUrl(network, response.hash)

      updatePendingToast(toastId, {
        description: `Your transaction is pending, click to view on etherscan`,
        href: txHref,
        target: '_blank',
        autoClose,
      })

      console.debug('response', response)
      console.time('waitForTransaction')
      // Poll for transaction receipt (can lead to faster results than .wait())
      const receipt = await new Promise<TransactionReceipt | null>(resolve => {
        let n = 0
        const pollReceipt = async () => {
          const receipt = await provider.getTransactionReceipt(response.hash)
          if (receipt) {
            resolve(receipt)
          } else if (n < 100) {
            n++
            setTimeout(pollReceipt, POLL_INTERVAL)
          } else {
            console.warn('Max retries exceeded')
            resolve(null)
          }
        }
        setTimeout(pollReceipt, POLL_INTERVAL)
      })
      console.debug('receipt', receipt)
      console.timeEnd('waitForTransaction')

      if (receipt) {
        if (receipt.status === TransactionStatus.Failure) {
          // ethers.js can't fetch revert data from reverted transactions
          handleError(new Error('Transaction reverted'), {
            ...successOrErrorOptions,
            contract,
            metadata,
            receipt,
            stage: TransactionErrorStage.Reverted,
          })
          return null
        } else {
          if (onComplete) {
            console.time('onComplete')
            await onComplete(receipt)
            console.timeEnd('onComplete')
          }

          postTransactionSuccess(receipt, successOrErrorOptions)

          updateToast(toastId, {
            variant: 'success',
            description: `Your transaction was successful`,
            href: txHref,
            target: '_blank',
            autoClose: DEFAULT_TOAST_INFO_TIMEOUT,
            icon: IconType.Check,
          })
          return receipt
        }
      } else {
        // Transaction timed out
        updateToast(toastId, {
          variant: 'warning',
          description: `Your transaction took longer than ${Math.floor(
            transactionTimeout / 1000
          )} seconds, click to view on etherscan`,
          href: txHref,
          target: '_blank',
          autoClose: DEFAULT_TOAST_INFO_TIMEOUT,
          icon: IconType.AlertTriangle,
        })
        return null
      }
    },
    [network, signer, account]
  )
}
