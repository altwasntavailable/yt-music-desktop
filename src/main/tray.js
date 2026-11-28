'use strict';

const { Tray, Menu, nativeImage } = require('electron');

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

class TrayController {
  constructor(options) {
    this.options = options;
    this.tray = null;
    this.state = null;
    this.visible = true;
    this.menu = null;
    this.signature = '';

    const image = nativeImage.createFromPath(options.iconPath);
    if (image.isEmpty()) {
      console.warn('[tray] Tray icon is empty or missing:', options.iconPath);
    }
    this.tray = new Tray(image);
    this.tray.setToolTip('YT Music Desktop');
    this.tray.on('click', () => this.options.onShowWindow());
    this.tray.on('double-click', () => this.options.onShowWindow());
    this.rebuild();
  }

  setVisible(visible) {
    const next = Boolean(visible);
    if (this.visible === next) return;
    this.visible = next;
    this.rebuild();
  }

  update(state) {
    this.state = state || null;
    const next = state
      ? `${state.title || ''}|${state.artist || ''}|${state.paused ? '1' : '0'}|${state.isAd ? '1' : '0'}`
      : '';
    if (next === this.signature) return;
    this.signature = next;
    this.rebuild();
  }

  rebuild() {
    if (!this.tray || this.tray.isDestroyed()) return;

    const state = this.state;
    const title = state && state.title ? truncate(state.title, 60) : '';
    const artist = state && state.artist ? truncate(state.artist, 60) : '';
    const tooltip = title
      ? `YT Music Desktop\n${title}${artist ? ` — ${artist}` : ''}`
      : 'YT Music Desktop';
    this.tray.setToolTip(truncate(tooltip, 120));

    const paused = !state || state.paused;
    const template = [];

    if (title) {
      template.push({
        label: truncate(`${title}${artist ? ` — ${artist}` : ''}`, 80),
        enabled: false
      });
      template.push({ type: 'separator' });
    }

    template.push(
      {
        label: this.visible ? 'Hide YT Music' : 'Show YT Music',
        click: () => {
          if (this.visible) this.options.onHideWindow();
          else this.options.onShowWindow();
        }
      },
      {
        label: 'Reload window',
        click: () => {
          if (this.options.onReloadWindow) this.options.onReloadWindow();
        }
      },
      {
        label: 'Reload player',
        click: () => {
          if (this.options.onReloadPlayer) this.options.onReloadPlayer();
        }
      },
      { type: 'separator' },
      {
        label: paused ? 'Play' : 'Pause',
        click: () => this.options.onCommand('play-pause')
      },
      {
        label: 'Next track',
        click: () => this.options.onCommand('next')
      },
      {
        label: 'Previous track',
        click: () => this.options.onCommand('previous')
      },
      { type: 'separator' },
      {
        label: 'Offline downloads',
        click: () => this.options.onCommand('toggle-downloads')
      },
      {
        label: 'Download current track',
        click: () => this.options.onCommand('download-current')
      },
      { type: 'separator' },
      {
        label: 'Lyrics',
        click: () => this.options.onCommand('toggle-lyrics')
      },
      {
        label: 'Equalizer',
        click: () => this.options.onCommand('toggle-equalizer')
      },
      {
        label: 'Settings',
        click: () => this.options.onCommand('toggle-settings')
      },
      { type: 'separator' },
      {
        label: 'Quit YT Music',
        click: () => this.options.onQuit()
      }
    );

    this.menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(this.menu);
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
    }
    this.tray = null;
    this.menu = null;
  }
}

module.exports = { TrayController };
