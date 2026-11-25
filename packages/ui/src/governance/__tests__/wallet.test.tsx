import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Wallet } from "../shared";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectors: [] as { uid: string; id: string; type: string; name: string }[],
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false }),
  useConnect: () => ({ connectors: mocks.connectors, connect: mocks.connect, isPending: false, error: null }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
}));

const injected = { uid: "1", id: "injected", type: "injected", name: "Injected" };
const walletConnect = { uid: "2", id: "walletConnect", type: "walletConnect", name: "WalletConnect" };
const rabby = { uid: "3", id: "io.rabby", type: "injected", name: "Rabby Wallet" };
const phantom = { uid: "4", id: "app.phantom", type: "injected", name: "Phantom" };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const connectOnce = () => {
  act(() => root.render(<Wallet />));
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.map((b) => b.textContent)).toEqual(["Connect wallet"]);
  act(() => buttons[0].click());
  return mocks.connect.mock.calls[0][0].connector;
};

it("shows one button and uses the browser's default wallet over announced ones", () => {
  mocks.connectors = [injected, phantom, walletConnect, rabby];
  vi.stubGlobal("ethereum", {});
  expect(connectOnce()).toBe(injected);
});

it("uses an announced wallet when the browser has no default wallet", () => {
  mocks.connectors = [injected, rabby, walletConnect];
  expect(connectOnce()).toBe(rabby);
});

it("falls back to WalletConnect when the browser has no wallet", () => {
  mocks.connectors = [injected, walletConnect];
  expect(connectOnce()).toBe(walletConnect);
});
