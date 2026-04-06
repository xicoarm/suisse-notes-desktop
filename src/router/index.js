import { createRouter, createMemoryHistory, createWebHistory, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { isMobile, isCapacitor } from '../utils/platform';

const routes = [
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        redirect: () => {
          // Mobile: go to login first (or record if authenticated)
          // Desktop: go to about page
          return isMobile() ? '/login' : '/about';
        }
      },
      {
        path: 'about',
        name: 'about',
        component: () => import('../pages/AboutPage.vue'),
        meta: { requiresAuth: false }
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
        meta: { requiresAuth: false },
        beforeEnter: (to, from, next) => {
          // Apple Guideline 3.1.1: hide registration on mobile to avoid
          // "external mechanism for purchases" rejection
          if (isCapacitor()) {
            next({ name: 'login' });
          } else {
            next();
          }
        }
      },
      {
        path: 'record',
        name: 'record',
        component: () => import('../pages/RecordPage.vue'),
        meta: { requiresAuth: true }
      },
      {
        path: 'upload',
        name: 'upload',
        component: () => import('../pages/UploadPage.vue'),
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
      },
      {
        path: 'device',
        name: 'device',
        component: () => import('../pages/DevicePage.vue'),
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
      // Block navigation during any active recording or upload phase
      const { useRecordingStore } = await import('../stores/recording');
      const recordingStore = useRecordingStore();

      if (from.name === 'record' && to.name !== 'record' && recordingStore.isBlocking) {
        next({ name: 'record' });
        return;
      }

      // Block navigation away from upload page during active file upload
      if (from.name === 'upload' && to.name !== 'upload' && recordingStore.isBlocking) {
        next({ name: 'upload' });
        return;
      }

      // Prevent navigating to upload page while recording is active
      if (to.name === 'upload' && recordingStore.isBlocking) {
        next({ name: 'record' });
        return;
      }

      next();
    }
  });

  return Router;
}
