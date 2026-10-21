import React, { Component, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

class ErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}
  static getDerivedStateFromError(){return {failed:true}}
  render(){if(this.state.failed)return <main className="fatal-error"><h1>화면을 다시 열어주세요.</h1><p>표시하는 중 문제가 발생했어요. 저장한 서버 데이터는 유지됩니다.</p><button className="primary-button" onClick={()=>window.location.reload()}>새로고침</button></main>;return this.props.children}
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>)
if(import.meta.env.PROD&&'serviceWorker'in navigator){window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>undefined)})}
