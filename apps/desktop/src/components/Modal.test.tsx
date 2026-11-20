import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, test, expect, vi } from 'vitest';
import { Modal } from './Modal';
import { EmployeeSelect } from './EmployeeSelect';
import type { EmployeeOption } from '@trf/shared';
import { TeamType } from '@trf/shared';

afterEach(() => {
  cleanup();
  document.body.classList.remove('modal-open');
});

test('renders title and children when open', () => {
  render(
    <Modal open={true} onClose={() => {}} title="Confirm delete">
      <p>Are you sure?</p>
    </Modal>
  );
  const title = screen.getByText('Confirm delete');
  const body = screen.getByText('Are you sure?');
  expect(title).toBeTruthy();
  expect(body).toBeTruthy();
});

test('renders nothing when closed', () => {
  render(
    <Modal open={false} onClose={() => {}} title="Closed">
      <p>Hidden</p>
    </Modal>
  );
  expect(screen.queryByText('Closed')).toBeNull();
  expect(screen.queryByText('Hidden')).toBeNull();
});

test('clicking the backdrop closes the modal when not busy', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={onClose} title="Modal">
      <button>Inside</button>
    </Modal>
  );
  const backdrop = document.querySelector('.modal-backdrop');
  expect(backdrop).not.toBeNull();
  await user.click(backdrop as Element);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('clicking the backdrop does not close when busy', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={onClose} title="Modal" busy={true}>
      <button>Inside</button>
    </Modal>
  );
  const backdrop = document.querySelector('.modal-backdrop');
  await user.click(backdrop as Element);
  expect(onClose).not.toHaveBeenCalled();
});

test('Escape closes the modal when not busy', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={onClose} title="Modal">
      <button>Inside</button>
    </Modal>
  );
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape does not close when busy', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={onClose} title="Modal" busy={true}>
      <button>Inside</button>
    </Modal>
  );
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
});

test('adds body.modal-open class when open and removes on unmount', () => {
  const { unmount } = render(
    <Modal open={true} onClose={() => {}} title="Modal">
      <button>Inside</button>
    </Modal>
  );
  expect(document.body.classList.contains('modal-open')).toBe(true);
  unmount();
  expect(document.body.classList.contains('modal-open')).toBe(false);
});

test('first focusable element is auto-focused', async () => {
  render(
    <Modal open={true} onClose={() => {}} title="Modal">
      <input type="text" placeholder="First field" />
      <button>Save</button>
    </Modal>
  );
  const firstInput = screen.getByPlaceholderText('First field');
  await waitFor(() => {
    expect(document.activeElement).toBe(firstInput);
  });
});

test('typing in an input keeps focus on that input', async () => {
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={() => {}} title="Modal">
      <input type="text" placeholder="First field" />
      <button>Save</button>
    </Modal>
  );
  const firstInput = screen.getByPlaceholderText('First field');
  await waitFor(() => {
    expect(document.activeElement).toBe(firstInput);
  });
  await user.type(firstInput, 'hello');
  expect(document.activeElement).toBe(firstInput);
  expect((firstInput as HTMLInputElement).value).toBe('hello');
});

test('modal with EmployeeSelect focuses the employee select input', async () => {
  const mockOptions: EmployeeOption[] = [
    { id: 1, employeeCode: 'EMP001', fullName: 'John Doe', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' as TeamType },
    { id: 2, employeeCode: 'EMP002', fullName: 'Jane Smith', designation: 'Manager', departmentName: 'FRD', team: 'FRD' as TeamType },
  ];
  
  render(
    <Modal open={true} onClose={() => {}} title="Modal">
      <EmployeeSelect
        id="test-employee"
        label="Test Employee"
        value=""
        options={mockOptions}
        onChange={vi.fn()}
        placeholder="Search an employee..."
      />
      <button>Save</button>
    </Modal>
  );
  
  const input = screen.getByPlaceholderText('Search an employee...');
  await waitFor(() => {
    expect(document.activeElement).toBe(input);
  });
});

test('typing in EmployeeSelect inside Modal keeps focus', async () => {
  const mockOptions: EmployeeOption[] = [
    { id: 1, employeeCode: 'EMP001', fullName: 'John Doe', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' as TeamType },
    { id: 2, employeeCode: 'EMP002', fullName: 'Jane Smith', designation: 'Manager', departmentName: 'FRD', team: 'FRD' as TeamType },
  ];
  
  const user = userEvent.setup();
  render(
    <Modal open={true} onClose={() => {}} title="Modal">
      <EmployeeSelect
        id="test-employee"
        label="Test Employee"
        value=""
        options={mockOptions}
        onChange={vi.fn()}
        placeholder="Search an employee..."
      />
      <button>Save</button>
    </Modal>
  );
  
  const input = screen.getByPlaceholderText('Search an employee...');
  await waitFor(() => {
    expect(document.activeElement).toBe(input);
  });
  
  await user.type(input, 'john');
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('john');
});

test('has correct aria attributes', () => {
  render(
    <Modal open={true} onClose={() => {}} title="Modal title">
      <button>Inside</button>
    </Modal>
  );
  const dialog = document.querySelector('.modal');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('role')).toBe('dialog');
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  const titleEl = dialog?.querySelector('h2');
  expect(titleEl?.textContent).toBe('Modal title');
  expect(dialog?.getAttribute('aria-labelledby')).toBe(titleEl?.id);
});

test('does not render aria-labelledby when title is empty', () => {
  render(
    <Modal open={true} onClose={() => {}} title={''}>
      <button>Inside</button>
    </Modal>
  );
  const dialog = document.querySelector('.modal');
  expect(dialog?.getAttribute('aria-labelledby')).toBeNull();
});

test('applies custom className to the dialog', () => {
  render(
    <Modal open={true} onClose={() => {}} title="Modal" className="modal--danger">
      <button>Inside</button>
    </Modal>
  );
  const dialog = document.querySelector('.modal');
  expect(dialog?.className).toContain('modal--danger');
});
