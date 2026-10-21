import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './api'
import './styles.css'

// 按平台微调样式（macOS 要给左上角红绿灯留位置）
document.documentElement.dataset.platform = window.wallet.platform

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
