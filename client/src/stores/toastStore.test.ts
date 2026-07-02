import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToastStore, toast } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  it('starts with no toasts', () => {
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('adds a toast', () => {
    useToastStore.getState().addToast('success', 'Test message');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toBe('Test message');
    expect(toasts[0].duration).toBe(5000);
  });

  it('adds a toast with custom duration', () => {
    useToastStore.getState().addToast('error', 'Error msg', 10000);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].duration).toBe(10000);
  });

  it('removes a toast by id', () => {
    useToastStore.getState().addToast('info', 'Toast 1');
    useToastStore.getState().addToast('warning', 'Toast 2');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);

    useToastStore.getState().removeToast(toasts[0].id);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe('Toast 2');
  });

  it('auto-removes toast after duration', () => {
    useToastStore.getState().addToast('info', 'Auto remove', 3000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(3000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('does not remove toast before duration', () => {
    useToastStore.getState().addToast('info', 'Pending', 5000);
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('assigns unique ids to each toast', () => {
    useToastStore.getState().addToast('info', 'A');
    useToastStore.getState().addToast('info', 'B');
    const ids = useToastStore.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('toast convenience helpers', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('toast.success adds a success toast', () => {
    toast.success('Success!');
    const t = useToastStore.getState().toasts[0];
    expect(t.type).toBe('success');
    expect(t.message).toBe('Success!');
  });

  it('toast.error adds an error toast', () => {
    toast.error('Error!');
    const t = useToastStore.getState().toasts[0];
    expect(t.type).toBe('error');
  });

  it('toast.info adds an info toast', () => {
    toast.info('Info!');
    const t = useToastStore.getState().toasts[0];
    expect(t.type).toBe('info');
  });

  it('toast.warning adds a warning toast', () => {
    toast.warning('Warning!');
    const t = useToastStore.getState().toasts[0];
    expect(t.type).toBe('warning');
  });
});
