import { createRoot } from 'react-dom/client';
import App from './App';
import 'react-diff-view/style/index.css';
import './styles.css';
import './product.css';

createRoot(document.getElementById('root')!).render(<App />);
