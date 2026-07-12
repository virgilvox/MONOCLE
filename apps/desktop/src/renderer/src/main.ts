import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'

// Self-hosted fonts, bundled per weight so no request ever leaves the app.
// IBM Plex Sans for the UI, IBM Plex Mono for telemetry, Space Grotesk for the
// wordmark and large readouts.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'

import './styles/main.css'

createApp(App).use(createPinia()).mount('#app')
