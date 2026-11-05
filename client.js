/**
 * 客户端入口（M5）：会话头部一个「家」按钮，打开固定入口的只读页面。
 * 不在页面里读数据，也不改任何东西——数据由 entry.mjs 的 /home 路由
 * 直接读 SQLite 后服务端渲染，客户端只负责带路。
 */
window.__ModuleLoader__.load({
  id: 'life-innovation',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const HOME_URL = '/life-innovation/home'

    function HomeAction() {
      return h('a', {
        href: HOME_URL,
        target: '_blank',
        rel: 'noreferrer',
        title: '去她家看看（只读）',
        'aria-label': '去她家看看（只读）',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          height: '28px',
          padding: '0 9px',
          borderRadius: '8px',
          color: 'var(--dsw-alias-text-secondary, #a8a29a)',
          textDecoration: 'none',
          fontSize: '12px',
          lineHeight: '1',
          border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12))',
          background: 'transparent',
          whiteSpace: 'nowrap',
        },
      }, h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      }, h('path', {
        d: 'M2.5 7.2 8 2.6l5.5 4.6V13a.8.8 0 0 1-.8.8H9.6V9.7H6.4v4.1H3.3a.8.8 0 0 1-.8-.8V7.2Z',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinejoin: 'round',
      })), '家')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'life-innovation-home',
          order: 40,
        }, HomeAction))
      },
    }
  },
})
