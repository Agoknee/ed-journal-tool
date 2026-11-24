import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

import staticConfig from './static.json' with { type: 'json' };
import appConfig from '../package.json' with { type: 'json' };
const { name, version } = appConfig;

const store = createStore(subscribeWithSelector((set, get) => ({
  config: {
    ...staticConfig,
    name,
    version,
  },
  setConfig: (newConfig) => set(({ config }) => ({ config: typeof newConfig === 'function' ? newConfig(config) : newConfig })),
})));

export default store;