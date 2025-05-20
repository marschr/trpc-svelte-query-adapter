export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

let todos: Todo[] = [
  { id: 1, text: 'Learn Svelte', done: true },
  { id: 2, text: 'Learn tRPC', done: true },
  { id: 3, text: 'Build a tRPC-SvelteQuery app', done: false },
  { id: 4, text: 'Profit!', done: false },
];

let nextId = todos.length + 1;

export const mockDb = {
  todo: {
    findMany: async (options?: { where?: (todo: Todo) => boolean }): Promise<Todo[]> => {
      if (options?.where) {
        return todos.filter(options.where);
      }
      return [...todos];
    },
    create: async (data: { text: string }): Promise<Todo> => {
      const newTodo: Todo = {
        id: nextId++,
        text: data.text,
        done: false,
      };
      todos.push(newTodo);
      return newTodo;
    },
    update: async (options: { where: { id: number }; data: Partial<Omit<Todo, 'id'>> }): Promise<Todo | undefined> => {
      const todoIndex = todos.findIndex(t => t.id === options.where.id);
      if (todoIndex === -1) {
        return undefined;
      }
      todos[todoIndex] = { ...todos[todoIndex], ...options.data };
      return todos[todoIndex];
    },
    delete: async (options: { where: { id: number } }): Promise<Todo | undefined> => {
      const todoIndex = todos.findIndex(t => t.id === options.where.id);
      if (todoIndex === -1) {
        return undefined;
      }
      const deletedTodo = todos.splice(todoIndex, 1)[0];
      return deletedTodo;
    },
  }
};

// Helper to reset DB for testing or specific scenarios if needed
export const resetDb = () => {
  todos = [
    { id: 1, text: 'Learn Svelte', done: true },
    { id: 2, text: 'Learn tRPC', done: true },
    { id: 3, text: 'Build a tRPC-SvelteQuery app', done: false },
    { id: 4, text: 'Profit!', done: false },
  ];
  nextId = todos.length + 1;
}; 