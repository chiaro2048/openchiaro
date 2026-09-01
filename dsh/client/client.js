window.__ModuleLoader__.load({
  id: 'dsh-openchiaro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const CHUNK_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
    let chunkPromise

    function loadTag(tag, attributes) {
      return new Promise((resolve, reject) => {
        const element = document.createElement(tag)
        Object.assign(element, attributes)
        element.addEventListener('load', resolve, { once: true })
        element.addEventListener('error', () => reject(new Error(`Chiaro 资源加载失败：${attributes.src || attributes.href}`)), { once: true })
        document.head.append(element)
      })
    }

    function loadChunk(ctx) {
      if (chunkPromise) return chunkPromise
      chunkPromise = Promise.all([
        ...CHUNK_EXTERNALS.map(async (specifier) => [specifier, await ctx.modules.import(specifier)]),
        loadTag('link', { rel: 'stylesheet', href: '/chiaro/bundle/excalidraw.css' }),
        loadTag('script', { async: true, src: '/chiaro/bundle/excalidraw.js' }),
      ]).then((values) => {
        const table = new Map(values.slice(0, CHUNK_EXTERNALS.length))
        const factory = globalThis.__dshChiaroChunks__?.excalidraw
        if (typeof factory !== 'function') throw new Error('Chiaro chunk 没有注册 factory')
        return factory((specifier) => {
          if (!table.has(specifier)) throw new Error(`Chiaro chunk 缺少外部模块：${specifier}`)
          return table.get(specifier)
        })
      }).catch((error) => {
        chunkPromise = undefined
        throw error
      })
      return chunkPromise
    }

    function useHash() {
      const [hash, setHash] = React.useState(() => window.location.hash)
      React.useEffect(() => {
        const update = () => setHash(window.location.hash)
        window.addEventListener('hashchange', update)
        return () => window.removeEventListener('hashchange', update)
      }, [])
      return hash
    }

    function ChiaroPage({ ctx }) {
      const active = ['#chiaro', '#/chiaro'].includes(useHash())
      const [Canvas, setCanvas] = React.useState()
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (!active || Canvas) return undefined
        let disposed = false
        void loadChunk(ctx).then((loaded) => {
          if (!disposed) setCanvas(() => loaded.ChiaroCanvas)
        }).catch((cause) => {
          if (!disposed) setError(cause.message)
        })
        return () => { disposed = true }
      }, [active, Canvas, ctx])
      if (!active) return null
      return ReactDOM.createPortal(
        Canvas
          ? h(Canvas, { ctx, onClose: () => { window.location.hash = '' } })
          : h('div', {
            role: 'status',
            style: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'grid', placeItems: 'center', background: '#f7f8fa' },
          }, error || '正在加载 Chiaro 画布…'),
        document.body,
      )
    }

    function ChiaroNav() {
      return h('button', {
        type: 'button',
        title: '打开 Chiaro 画布',
        onClick: () => { window.location.hash = '#chiaro' },
      }, 'Chiaro')
    }

    exports.name = 'dsh-openchiaro'
    exports.inject = ['slots', 'sessions', 'modules']
    exports.apply = (ctx) => {
      const Overlay = () => h(ChiaroPage, { ctx })
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-openchiaro-page', order: 900,
      }, Overlay))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'dsh-openchiaro-nav', order: 110, label: () => 'Chiaro',
      }, ChiaroNav))
    }
    return module.exports
  },
})
