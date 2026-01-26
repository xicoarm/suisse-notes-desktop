<template>
  <q-page class="about-page">
    <div class="about-container">
      <!-- Hero Section -->
      <section class="hero-section">
        <div class="hero-icon">
          <q-icon
            name="record_voice_over"
            size="64px"
            color="primary"
          />
        </div>
        <h1 class="hero-title">
          Suisse Notes
        </h1>
        <p class="hero-subtitle">
          {{ $t('aboutHeroSubtitle') }}
        </p>

        <!-- CTA Buttons - Two options for authenticated users -->
        <div class="hero-cta">
          <template v-if="!authStore.isAuthenticated">
            <q-btn
              unelevated
              color="primary"
              :label="$t('aboutGetStarted')"
              icon="arrow_forward"
              class="cta-btn"
              @click="goToLogin"
            />
          </template>
          <template v-else>
            <div class="hero-buttons">
              <q-btn
                unelevated
                color="primary"
                :label="$t('recordAudio')"
                icon="mic"
                class="cta-btn primary-cta pulse-btn"
                @click="goToRecord"
              />
              <span class="or-text">{{ $t('or') }}</span>
              <q-btn
                outline
                color="primary"
                :label="$t('uploadFileTab')"
                icon="cloud_upload"
                class="cta-btn secondary-cta"
                @click="goToUpload"
              />
            </div>
          </template>
        </div>
      </section>

      <!-- Features Grid -->
      <section class="features-section">
        <h2 class="section-title">
          {{ $t('aboutFeaturesTitle') }}
        </h2>

        <div class="features-grid">
          <!-- Swiss German Support -->
          <div class="feature-card">
            <div class="feature-icon swiss-icon">
              <q-icon
                name="language"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeatureSwissTitle') }}</h3>
            <p>{{ $t('aboutFeatureSwissDesc') }}</p>
          </div>

          <!-- Multi-Platform -->
          <div class="feature-card">
            <div class="feature-icon platform-icon">
              <q-icon
                name="devices"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeaturePlatformTitle') }}</h3>
            <p>{{ $t('aboutFeaturePlatformDesc') }}</p>
          </div>

          <!-- AI Summaries -->
          <div class="feature-card">
            <div class="feature-icon ai-icon">
              <q-icon
                name="auto_awesome"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeatureAITitle') }}</h3>
            <p>{{ $t('aboutFeatureAIDesc') }}</p>
          </div>

          <!-- Speaker Recognition -->
          <div class="feature-card">
            <div class="feature-icon speaker-icon">
              <q-icon
                name="group"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeatureSpeakerTitle') }}</h3>
            <p>{{ $t('aboutFeatureSpeakerDesc') }}</p>
          </div>

          <!-- Security -->
          <div class="feature-card">
            <div class="feature-icon security-icon">
              <q-icon
                name="shield"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeatureSecurityTitle') }}</h3>
            <p>{{ $t('aboutFeatureSecurityDesc') }}</p>
          </div>

          <!-- Action Items -->
          <div class="feature-card">
            <div class="feature-icon action-icon">
              <q-icon
                name="checklist"
                size="28px"
              />
            </div>
            <h3>{{ $t('aboutFeatureActionsTitle') }}</h3>
            <p>{{ $t('aboutFeatureActionsDesc') }}</p>
          </div>
        </div>
      </section>

      <!-- Integrations Section -->
      <section class="integrations-section">
        <h2 class="section-title">
          {{ $t('aboutIntegrationsTitle') }}
        </h2>
        <p class="section-desc">
          {{ $t('aboutIntegrationsDesc') }}
        </p>

        <div class="integrations-grid">
          <div class="integration-item">
            <div class="integration-icon teams">
              <span class="platform-letter">T</span>
            </div>
            <span>Microsoft Teams</span>
          </div>
          <div class="integration-item">
            <div class="integration-icon zoom">
              <span class="platform-letter">Z</span>
            </div>
            <span>Zoom</span>
          </div>
          <div class="integration-item">
            <div class="integration-icon meet">
              <span class="platform-letter">G</span>
            </div>
            <span>Google Meet</span>
          </div>
          <div class="integration-item">
            <div class="integration-icon webex">
              <span class="platform-letter">W</span>
            </div>
            <span>Webex</span>
          </div>
        </div>

        <!-- Calendar Connection CTA - Only for authenticated users -->
        <div
          v-if="authStore.isAuthenticated"
          class="calendar-cta"
        >
          <q-btn
            outline
            color="primary"
            :label="$t('connectCalendarBtn')"
            icon="event"
            class="calendar-btn"
            @click="openCalendarSettings"
          />
          <p class="calendar-hint">
            {{ $t('connectCalendarHint') }}
          </p>
        </div>
      </section>

      <!-- Company Section -->
      <section class="company-section">
        <div class="company-badge">
          <q-icon
            name="verified"
            size="20px"
            color="primary"
          />
          <span>{{ $t('aboutMadeInSwitzerland') }}</span>
        </div>
        <h2 class="company-name">
          Suisse AI Group GmbH
        </h2>
        <p class="company-desc">
          {{ $t('aboutCompanyDesc') }}
        </p>

        <div class="company-details">
          <div class="detail-item">
            <q-icon
              name="location_on"
              size="16px"
              color="grey-6"
            />
            <span>Kirchstrasse 3, 8304 Wallisellen, Schweiz</span>
          </div>
          <div class="detail-item">
            <q-icon
              name="language"
              size="16px"
              color="grey-6"
            />
            <a
              href="https://suisse-ai.ch"
              target="_blank"
              rel="noopener"
            >suisse-ai.ch</a>
          </div>
        </div>
      </section>

      <!-- Legal Section -->
      <section class="legal-section">
        <div class="legal-links">
          <a
            href="#"
            @click.prevent="openLegalLink('https://suisse-notes.ch/privacy')"
          >
            <q-icon
              name="privacy_tip"
              size="14px"
            />
            {{ $t('privacyPolicy') }}
          </a>
          <span class="divider">|</span>
          <a
            href="#"
            @click.prevent="openLegalLink('https://suisse-notes.ch/terms')"
          >
            <q-icon
              name="description"
              size="14px"
            />
            {{ $t('termsOfService') }}
          </a>
          <span class="divider">|</span>
          <a
            href="#"
            @click.prevent="openLegalLink('https://suisse-notes.ch/impressum')"
          >
            <q-icon
              name="info"
              size="14px"
            />
            {{ $t('impressum') }}
          </a>
        </div>
        <p class="copyright">
          © {{ currentYear }} Suisse AI Group GmbH. All rights reserved.
        </p>
      </section>
    </div>
  </q-page>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { isElectron, isCapacitor } from '../utils/platform';

const router = useRouter();
const authStore = useAuthStore();

const currentYear = computed(() => new Date().getFullYear());

const goToLogin = () => {
  router.push('/login');
};

const goToRecord = () => {
  router.push('/record');
};

const goToUpload = () => {
  router.push('/upload');
};

const openCalendarSettings = async () => {
  const url = 'https://app.suisse-notes.ch/settings/integrations';

  if (isElectron()) {
    let finalUrl = url;
    try {
      const result = await window.electronAPI.auth.createWebSession();
      if (result.success && result.sessionToken) {
        finalUrl += `?session=${encodeURIComponent(result.sessionToken)}`;
      }
    } catch (error) {
      console.warn('Could not create web session:', error);
    }
    window.electronAPI.shell.openExternal(finalUrl);
  } else if (isCapacitor()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  }
};

const openLegalLink = async (url) => {
  if (isElectron()) {
    window.electronAPI.shell.openExternal(url);
  } else if (isCapacitor()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else {
    window.open(url, '_blank');
  }
};
</script>

<style lang="scss" scoped>
.about-page {
  padding: 40px 48px;
  background: linear-gradient(180deg, #fafbff 0%, #ffffff 100%);
  min-height: 100%;

  @media (max-width: 600px) {
    padding: 20px 16px;
  }
}

.about-container {
  max-width: 800px;
  margin: 0 auto;
}

// Hero Section
.hero-section {
  text-align: center;
  padding: 40px 0 48px;
}

.hero-icon {
  width: 100px;
  height: 100px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%);
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 24px;
}

.hero-title {
  font-size: 28px;
  font-weight: 700;
  color: #1e293b;
  margin: 0 0 12px;
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-subtitle {
  font-size: 14px;
  color: #64748b;
  margin: 0;
  max-width: 500px;
  margin: 0 auto;
  line-height: 1.6;
}

.hero-cta {
  margin-top: 28px;

  .cta-btn {
    padding: 14px 36px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 10px;
    transition: all 0.3s ease;

    &:hover {
      transform: translateY(-2px);
    }
  }

  .hero-buttons {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .primary-cta {
    box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);

    &:hover {
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
    }
  }

  .secondary-cta {
    box-shadow: none;

    &:hover {
      background: rgba(99, 102, 241, 0.08);
      box-shadow: none;
    }
  }

  .or-text {
    font-size: 13px;
    color: #94a3b8;
    font-weight: 500;
  }

  .pulse-btn {
    animation: pulse-shadow 2s ease-in-out infinite;
  }

  @keyframes pulse-shadow {
    0%, 100% {
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);
    }
    50% {
      box-shadow: 0 4px 24px rgba(99, 102, 241, 0.55), 0 0 0 6px rgba(99, 102, 241, 0.1);
    }
  }
}

// Features Section
.features-section {
  padding: 32px 0;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
  text-align: center;
  margin: 0 0 24px;
}

.section-desc {
  font-size: 13px;
  color: #64748b;
  text-align: center;
  margin: 0 0 24px;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}

.feature-card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 20px;
  transition: all 0.2s ease;

  &:hover {
    border-color: #c7d2fe;
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.08);
  }

  // Center content on mobile (single column layout)
  @media (max-width: 600px) {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: #1e293b;
    margin: 12px 0 6px;
  }

  p {
    font-size: 11px;
    color: #64748b;
    margin: 0;
    line-height: 1.5;
  }
}

.feature-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;

  &.swiss-icon {
    background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
    color: #dc2626;
  }

  &.platform-icon {
    background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
    color: #2563eb;
  }

  &.ai-icon {
    background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%);
    color: #9333ea;
  }

  &.speaker-icon {
    background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
    color: #059669;
  }

  &.security-icon {
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    color: #d97706;
  }

  &.action-icon {
    background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
    color: #4f46e5;
  }
}

// Integrations Section
.integrations-section {
  padding: 32px 0;
  text-align: center;
}

.integrations-grid {
  display: flex;
  justify-content: center;
  gap: 24px;
  flex-wrap: wrap;
  margin-top: 20px;
}

.integration-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;

  span {
    font-size: 11px;
    color: #64748b;
    font-weight: 500;
  }
}

.integration-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  border: 1px solid #e2e8f0;
  transition: all 0.2s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }

  .platform-letter {
    font-size: 20px;
    font-weight: 700;
  }

  &.teams {
    background: linear-gradient(135deg, #5c5bbd 0%, #7b83eb 100%);
    .platform-letter { color: white; }
  }

  &.zoom {
    background: linear-gradient(135deg, #2d8cff 0%, #0b5cff 100%);
    .platform-letter { color: white; }
  }

  &.meet {
    background: linear-gradient(135deg, #00ac47 0%, #34a853 100%);
    .platform-letter { color: white; }
  }

  &.webex {
    background: linear-gradient(135deg, #00bceb 0%, #007aa3 100%);
    .platform-letter { color: white; }
  }
}

// Calendar CTA
.calendar-cta {
  margin-top: 28px;
  text-align: center;

  .calendar-btn {
    padding: 10px 24px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 10px;
  }

  .calendar-hint {
    margin-top: 10px;
    font-size: 11px;
    color: #94a3b8;
  }
}

// Company Section
.company-section {
  padding: 32px 0;
  text-align: center;
  border-top: 1px solid #e2e8f0;
  margin-top: 16px;
}

.company-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(139, 92, 246, 0.08) 100%);
  border-radius: 20px;
  font-size: 11px;
  color: #6366F1;
  font-weight: 500;
  margin-bottom: 16px;
}

.company-name {
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
  margin: 0 0 8px;
}

.company-desc {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 20px;
  max-width: 450px;
  margin-left: auto;
  margin-right: auto;
  line-height: 1.6;
}

.company-details {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.detail-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748b;

  a {
    color: #6366F1;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

// Legal Section
.legal-section {
  padding: 24px 0 16px;
  text-align: center;
  border-top: 1px solid #e2e8f0;
  margin-top: 16px;
}

.legal-links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;

  a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #64748b;
    text-decoration: none;
    transition: color 0.2s ease;

    &:hover {
      color: #6366F1;
    }
  }

  .divider {
    color: #cbd5e1;
    font-size: 12px;

    @media (max-width: 400px) {
      display: none;
    }
  }

  @media (max-width: 400px) {
    flex-direction: column;
    gap: 8px;
  }
}

.copyright {
  font-size: 11px;
  color: #94a3b8;
  margin: 0;
}

</style>
