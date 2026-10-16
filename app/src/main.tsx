import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { RainbowKitProvider, connectorsForWallets, lightTheme, darkTheme } from '@rainbow-me/rainbowkit'
import {
  injectedWallet, metaMaskWallet, rabbyWallet, okxWallet, coinbaseWallet, walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets'
import '@rainbow-me/rainbowkit/styles.css'
import '@fontsource-variable/archivo/standard.css'
import '@fontsource-variable/martian-mono'
import './styles.css'
import { mezoTestnet } from './lib/chain'
import { App } from './App'
import { ToastProvider } from './components/Toasts'

const projectId = (import.meta.env.VITE_WC_PROJECT_ID ?? '').trim() || 'coil-no-walletconnect'
const hasWc = projectId !== 'coil-no-walletconnect'

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Browser wallets',
      wallets: [metaMaskWallet, rabbyWallet, okxWallet, coinbaseWallet, injectedWallet, ...(hasWc ? [walletConnectWallet] : [])],
    },
  ],
  { appName: 'Coil', projectId },
)

const wagmiConfig = createConfig({
  chains: [mezoTestnet],
  connectors,
  transports: { [mezoTestnet.id]: http() },
})

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

const base = { accentColor: '#F7931A', accentColorForeground: '#141414', borderRadius: 'small' as const, fontStack: 'system' as const }
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={mezoTestnet} theme={dark ? darkTheme(base) : lightTheme(base)} modalSize="compact">
          <ToastProvider>
            <App />
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
