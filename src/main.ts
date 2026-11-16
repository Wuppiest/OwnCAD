import './style.css';
import { initKernel } from './kernel/manifold';
import { initSolver } from './sketch/solver';
import { App } from './app';

async function boot() {
  const loading = document.getElementById('loading')!;
  try {
    await Promise.all([initKernel(), initSolver()]);
    const app = new App();
    (window as any).owncad = app;
    loading.remove();
  } catch (e) {
    console.error(e);
    loading.textContent = `Failed to start OwnCAD: ${(e as Error).message}`;
  }
}

boot();
