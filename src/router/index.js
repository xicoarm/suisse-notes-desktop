import { createRouter, createMemoryHistory, createWebHistory, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        redirect: '/login'
      },
      {
        path: 'login',
        name: 'login',
        component: () => import('../pages/LoginPage.vue'),
        meta: { requiresAuth: false }
      },
      {
        path: 'register',
        name: 'register',
        component: () => import('../pages/RegisterPage.vue'),
        meta: { requiresAuth: false }
      },
      {
        path: 'record',
        name: 'record',
        component: () => import('../pages/RecordPage.vue'),
        meta: { requiresAuth: true }
      },
      {
        path: 'history',
        name: 'history',
        component: () => import('../pages/HistoryPage.vue'),
        meta: { requiresAuth: true }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { requiresAuth: true }
      }
    ]
  },
  {
    path: '/:catchAll(.*)*',
    component: () => import('../pages/ErrorNotFound.vue')
  }
];

export default function (/* { store, ssrContext } */) {
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : (process.env.VUE_ROUTER_MODE === 'history' ? createWebHistory : createWebHashHistory);

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createHistory(process.env.VUE_ROUTER_BASE)
  });

  // Navigation guard for authentication
  Router.beforeEach(async (to, from, next) => {
    const authStore = useAuthStore();

    // Wait for session check to complete on first navigation
    if (!authStore.sessionChecked) {
      await authStore.checkSession();
    }

    if (to.meta.requiresAuth && !authStore.isAuthenticated) {
      next({ name: 'login' });
    } else if ((to.name === 'login' || to.name === 'register') && authStore.isAuthenticated) {
      next({ name: 'record' });
    } else {
      next();
    }
  });

  return Router;
}
