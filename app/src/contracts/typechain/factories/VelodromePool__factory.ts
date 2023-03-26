/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { Contract, Signer, utils } from "ethers";
import type { Provider } from "@ethersproject/providers";
import type { VelodromePool, VelodromePoolInterface } from "../VelodromePool";

const _abi = [
  {
    inputs: [],
    name: "reserve0",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "reserve1",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

export class VelodromePool__factory {
  static readonly abi = _abi;
  static createInterface(): VelodromePoolInterface {
    return new utils.Interface(_abi) as VelodromePoolInterface;
  }
  static connect(
    address: string,
    signerOrProvider: Signer | Provider
  ): VelodromePool {
    return new Contract(address, _abi, signerOrProvider) as VelodromePool;
  }
}