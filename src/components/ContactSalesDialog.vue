<template>
  <q-dialog
    v-model="dialogVisible"
    persistent
  >
    <q-card class="contact-sales-dialog">
      <q-card-section class="dialog-header">
        <div class="header-icon">
          <q-icon
            name="schedule"
            size="48px"
            color="warning"
          />
        </div>
        <div class="text-h6">
          {{ title }}
        </div>
        <div class="text-subtitle text-grey-6">
          {{ subtitle }}
        </div>
      </q-card-section>

      <q-card-section>
        <!-- The send button is never disabled: a click validates and the
             field says what is missing. The organisation is optional
             (private customers have none). -->
        <q-form
          ref="formRef"
          class="contact-form"
          @submit.prevent="onSubmit"
        >
          <q-input
            v-model="form.organizationName"
            :label="$t('organizationNameOptional')"
            outlined
            dense
            class="q-mb-md"
          />

          <q-input
            v-model.number="form.minutesNeeded"
            :label="$t('minutesNeededPerMonth')"
            type="number"
            min="1"
            outlined
            dense
            :rules="[val => isValidMinutes(val) || $t('minutesNeededInvalid')]"
            class="q-mb-md"
          />

          <q-input
            v-model="form.message"
            :label="$t('messageOptional')"
            type="textarea"
            outlined
            dense
            autogrow
            class="q-mb-sm"
          />
        </q-form>

        <div class="info-box">
          <q-icon
            name="info"
            size="xs"
            color="primary"
          />
          <span v-html="$t('contactInfoText', { email: `<strong>${userEmail}</strong>` })" />
        </div>
      </q-card-section>

      <q-card-actions
        align="right"
        class="dialog-actions"
      >
        <q-btn
          flat
          :label="$t('maybeLater')"
          color="grey-7"
          @click="onClose"
        />
        <q-btn
          unelevated
          :label="$t('contactSalesBtn')"
          class="gradient-btn"
          :loading="submitting"
          @click="onSubmit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script>
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { submitSalesInquiry } from '../services/api';
import { buildSalesInquiry, isValidMinutes } from '../utils/salesInquiry';

export default {
  name: 'ContactSalesDialog',

  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    // Context for why the dialog is shown
    reason: {
      type: String,
      default: 'limit_reached' // 'limit_reached', 'no_minutes', 'request_more'
    }
  },

  emits: ['update:modelValue', 'submitted', 'close'],

  setup(props, { emit }) {
    const $q = useQuasar();
    const { t } = useI18n();
    const authStore = useAuthStore();

    const dialogVisible = ref(props.modelValue);
    const submitting = ref(false);
    const formRef = ref(null);

    const form = ref({
      organizationName: '',
      minutesNeeded: 120,
      message: ''
    });

    const userEmail = computed(() => authStore.user?.email || '');

    const title = computed(() => {
      switch (props.reason) {
        case 'no_minutes':
          return t('noMinutesRemaining');
        case 'request_more':
          return t('getMoreMinutes');
        default:
          return t('contactSalesTitle');
      }
    });

    const subtitle = computed(() => {
      switch (props.reason) {
        case 'no_minutes':
          return t('contactSalesNoMinutes');
        case 'request_more':
          return t('contactSalesRequestMore');
        default:
          return t('contactSalesLimitReached');
      }
    });

    // Sync dialog visibility with prop
    watch(() => props.modelValue, (val) => {
      dialogVisible.value = val;
    });

    watch(dialogVisible, (val) => {
      emit('update:modelValue', val);
    });

    const onSubmit = async () => {
      if (submitting.value) return;
      // Validate on click: the field shows what is missing.
      const valid = formRef.value ? await formRef.value.validate(true) : isValidMinutes(form.value.minutesNeeded);
      if (!valid) return;

      submitting.value = true;

      try {
        const inquiry = buildSalesInquiry({ email: userEmail.value, ...form.value });

        await submitSalesInquiry(inquiry, authStore.token);

        $q.notify({
          type: 'positive',
          message: t('inquirySubmitted'),
          timeout: 5000
        });

        emit('submitted', inquiry);
        dialogVisible.value = false;

        // Reset form
        form.value = {
          organizationName: '',
          minutesNeeded: 120,
          message: ''
        };
      } catch (error) {
        console.error('Failed to submit inquiry:', error);
        $q.notify({
          type: 'negative',
          message: t('inquiryFailed'),
          timeout: 6000
        });
      } finally {
        submitting.value = false;
      }
    };

    const onClose = () => {
      emit('close');
      dialogVisible.value = false;
    };

    return {
      dialogVisible,
      form,
      formRef,
      submitting,
      userEmail,
      title,
      subtitle,
      isValidMinutes,
      onSubmit,
      onClose
    };
  }
};
</script>

<style lang="scss" scoped>
.contact-sales-dialog {
  min-width: 420px;
  max-width: 500px;
  border-radius: 16px;

  @media (max-width: 500px) {
    min-width: 90vw;
  }
}

.dialog-header {
  text-align: center;
  padding: 32px 24px 16px;

  .header-icon {
    margin-bottom: 16px;
  }

  .text-h6 {
    font-weight: 600;
    font-size: 18px;
    margin-bottom: 8px;
    color: #1e293b;
  }

  .text-subtitle {
    font-size: 14px;
    line-height: 1.5;
    max-width: 360px;
    margin: 0 auto;
  }
}

.contact-form {
  .q-input {
    :deep(.q-field__control) {
      border-radius: 8px;
    }
  }
}

.info-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  background: rgba(99, 102, 241, 0.08);
  border-radius: 8px;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;

  strong {
    color: #6366F1;
  }
}

.dialog-actions {
  padding: 16px 24px 24px;
  gap: 12px;
}

.gradient-btn {
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%) !important;
  color: white !important;
  padding: 8px 20px;
}
</style>
