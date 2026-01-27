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
        <q-form
          class="contact-form"
          @submit.prevent="onSubmit"
        >
          <q-input
            v-model="form.organizationName"
            label="Organization Name"
            outlined
            dense
            :rules="[val => !!val || 'Organization name is required']"
            class="q-mb-md"
          />

          <q-input
            v-model.number="form.minutesNeeded"
            label="Minutes needed per month"
            type="number"
            outlined
            dense
            :rules="[val => val > 0 || 'Please enter a valid number']"
            class="q-mb-md"
          />

          <q-input
            v-model="form.message"
            label="Message (optional)"
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
          <span>Our team will contact you at <strong>{{ userEmail }}</strong> within 24 hours.</span>
        </div>
      </q-card-section>

      <q-card-actions
        align="right"
        class="dialog-actions"
      >
        <q-btn
          flat
          label="Maybe Later"
          color="grey-7"
          @click="onClose"
        />
        <q-btn
          unelevated
          label="Contact Sales"
          class="gradient-btn"
          :loading="submitting"
          :disable="!isFormValid"
          @click="onSubmit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script>
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useAuthStore } from '../stores/auth';
import { submitSalesInquiry } from '../services/api';

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
    const authStore = useAuthStore();

    const dialogVisible = ref(props.modelValue);
    const submitting = ref(false);

    const form = ref({
      organizationName: '',
      minutesNeeded: 120,
      message: ''
    });

    const userEmail = computed(() => authStore.user?.email || '');

    const title = computed(() => {
      switch (props.reason) {
        case 'no_minutes':
          return 'No Minutes Remaining';
        case 'request_more':
          return 'Request More Minutes';
        default:
          return "You've Used All Your Free Minutes";
      }
    });

    const subtitle = computed(() => {
      switch (props.reason) {
        case 'no_minutes':
          return 'You need more minutes to start recording. Contact our sales team to continue.';
        case 'request_more':
          return 'Fill out the form below and our team will get back to you.';
        default:
          return 'Your recording has been saved. Contact our sales team to get more transcription minutes.';
      }
    });

    const isFormValid = computed(() => {
      return form.value.organizationName.trim() !== '' &&
             form.value.minutesNeeded > 0;
    });

    // Sync dialog visibility with prop
    watch(() => props.modelValue, (val) => {
      dialogVisible.value = val;
    });

    watch(dialogVisible, (val) => {
      emit('update:modelValue', val);
    });

    const onSubmit = async () => {
      if (!isFormValid.value) return;

      submitting.value = true;

      try {
        const inquiry = {
          email: userEmail.value,
          organizationName: form.value.organizationName,
          minutesNeeded: form.value.minutesNeeded,
          message: form.value.message || null
        };

        await submitSalesInquiry(inquiry, authStore.token);

        $q.notify({
          type: 'positive',
          message: 'Your inquiry has been submitted. We will contact you soon.',
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
          message: error.message || 'Failed to submit inquiry. Please try again.',
          timeout: 5000
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
      submitting,
      userEmail,
      title,
      subtitle,
      isFormValid,
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
