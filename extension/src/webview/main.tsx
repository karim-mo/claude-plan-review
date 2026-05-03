import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const mount = document.getElementById('root');
if (mount) {
	createRoot(mount).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
