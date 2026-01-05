import { createI18n } from 'vue-i18n';

const messages = {
  en: {
    // Record Page
    uploadFile: 'Upload File',
    dropHere: 'Drop file here',
    uploadDesc: 'Have an existing recording? Upload it for transcription.',
    selectFile: 'Select File',
    dragDropHint: 'or drag & drop a file here',
    recordNew: 'Record New',
    microphone: 'Microphone',
    systemAudio: 'System Audio',
    systemAudioDesc: 'Record all audio playing on your computer',
    systemAudioEnabled: 'System audio will be captured',
    macPermissionNotice: 'Screen Recording permission required on macOS',

    // Recording states
    readyToRecord: 'Ready to record',
    recordingInProgress: 'Recording in progress',
    recordingPaused: 'Recording paused',
    recordingStopped: 'Recording stopped',
    uploading: 'Uploading...',
    uploadComplete: 'Upload complete',
    processing: 'Processing...',

    // Tips
    tipsTitle: 'Tips for better recordings',
    tip1: 'Use a proper external microphone for best audio quality and speaker differentiation',
    tip2: 'Position the microphone close to the speakers',
    tip3: 'Recording will be automatically uploaded when you stop',
    tipsContact: 'Need help choosing a microphone? Contact us at',

    // Header
    record: 'Record',
    history: 'History',
    settings: 'Settings',
    signOut: 'Sign Out',
    maximize: 'Maximize Window',
    restore: 'Restore Window',

    // History
    noRecordings: 'No recordings yet',
    startRecording: 'Start your first recording',

    // Common
    cancel: 'Cancel',
    confirm: 'Confirm',
    delete: 'Delete',
    retry: 'Retry',
    viewHistory: 'View History',
    newRecording: 'New Recording',
    openInSuisseNotes: 'Open in Suisse Notes',
    transcriptReady: 'Your transcript is ready!',
    transcriptCta: 'Click below to view your transcript, summaries, and action items',

    // Stop Recording Dialog
    stopRecordingTitle: 'Stop Recording?',
    stopRecordingMessage: 'Your recording will be saved and uploaded for transcription.',
    continueRecording: 'Continue Recording',
    endRecording: 'End Recording',

    // Success Screen
    clickHereToView: 'Click here to view your transcript'
  },
  de: {
    // Record Page
    uploadFile: 'Datei hochladen',
    dropHere: 'Datei hier ablegen',
    uploadDesc: 'Haben Sie eine bestehende Aufnahme? Laden Sie sie zur Transkription hoch.',
    selectFile: 'Datei auswählen',
    dragDropHint: 'oder Datei hierher ziehen',
    recordNew: 'Neue Aufnahme',
    microphone: 'Mikrofon',
    systemAudio: 'Systemaudio',
    systemAudioDesc: 'Alle auf Ihrem Computer abgespielten Töne aufnehmen',
    systemAudioEnabled: 'Systemaudio wird aufgenommen',
    macPermissionNotice: 'Bildschirmaufnahme-Berechtigung auf macOS erforderlich',

    // Recording states
    readyToRecord: 'Bereit zur Aufnahme',
    recordingInProgress: 'Aufnahme läuft',
    recordingPaused: 'Aufnahme pausiert',
    recordingStopped: 'Aufnahme gestoppt',
    uploading: 'Wird hochgeladen...',
    uploadComplete: 'Upload abgeschlossen',
    processing: 'Wird verarbeitet...',

    // Tips
    tipsTitle: 'Tipps für bessere Aufnahmen',
    tip1: 'Verwenden Sie ein externes Mikrofon für beste Audioqualität und Sprechererkennung',
    tip2: 'Positionieren Sie das Mikrofon nahe an den Sprechern',
    tip3: 'Die Aufnahme wird automatisch hochgeladen, wenn Sie stoppen',
    tipsContact: 'Brauchen Sie Hilfe bei der Mikrofonwahl? Kontaktieren Sie uns unter',

    // Header
    record: 'Aufnehmen',
    history: 'Verlauf',
    settings: 'Einstellungen',
    signOut: 'Abmelden',
    maximize: 'Fenster maximieren',
    restore: 'Fenster wiederherstellen',

    // History
    noRecordings: 'Noch keine Aufnahmen',
    startRecording: 'Starten Sie Ihre erste Aufnahme',

    // Common
    cancel: 'Abbrechen',
    confirm: 'Bestätigen',
    delete: 'Löschen',
    retry: 'Erneut versuchen',
    viewHistory: 'Verlauf anzeigen',
    newRecording: 'Neue Aufnahme',
    openInSuisseNotes: 'In Suisse Notes öffnen',
    transcriptReady: 'Ihr Transkript ist bereit!',
    transcriptCta: 'Klicken Sie unten, um Ihr Transkript, Zusammenfassungen und Aktionspunkte anzuzeigen',

    // Stop Recording Dialog
    stopRecordingTitle: 'Aufnahme beenden?',
    stopRecordingMessage: 'Ihre Aufnahme wird gespeichert und zur Transkription hochgeladen.',
    continueRecording: 'Aufnahme fortsetzen',
    endRecording: 'Aufnahme beenden',

    // Success Screen
    clickHereToView: 'Hier klicken um Ihr Transkript anzuzeigen'
  },
  fr: {
    // Record Page
    uploadFile: 'Télécharger un fichier',
    dropHere: 'Déposez le fichier ici',
    uploadDesc: 'Vous avez un enregistrement existant? Téléchargez-le pour la transcription.',
    selectFile: 'Sélectionner un fichier',
    dragDropHint: 'ou glissez-déposez un fichier ici',
    recordNew: 'Nouvel enregistrement',
    microphone: 'Microphone',
    systemAudio: 'Audio système',
    systemAudioDesc: 'Enregistrer tous les sons de votre ordinateur',
    systemAudioEnabled: "L'audio système sera capturé",
    macPermissionNotice: "Autorisation d'enregistrement d'écran requise sur macOS",

    // Recording states
    readyToRecord: "Prêt à enregistrer",
    recordingInProgress: 'Enregistrement en cours',
    recordingPaused: 'Enregistrement en pause',
    recordingStopped: 'Enregistrement arrêté',
    uploading: 'Téléchargement...',
    uploadComplete: 'Téléchargement terminé',
    processing: 'Traitement...',

    // Tips
    tipsTitle: 'Conseils pour de meilleurs enregistrements',
    tip1: 'Utilisez un microphone externe pour une meilleure qualité audio et différenciation des locuteurs',
    tip2: 'Positionnez le microphone près des locuteurs',
    tip3: "L'enregistrement sera automatiquement téléchargé à l'arrêt",
    tipsContact: "Besoin d'aide pour choisir un microphone? Contactez-nous à",

    // Header
    record: 'Enregistrer',
    history: 'Historique',
    settings: 'Paramètres',
    signOut: 'Déconnexion',
    maximize: 'Maximiser la fenêtre',
    restore: 'Restaurer la fenêtre',

    // History
    noRecordings: "Pas encore d'enregistrements",
    startRecording: 'Commencez votre premier enregistrement',

    // Common
    cancel: 'Annuler',
    confirm: 'Confirmer',
    delete: 'Supprimer',
    retry: 'Réessayer',
    viewHistory: "Voir l'historique",
    newRecording: 'Nouvel enregistrement',
    openInSuisseNotes: 'Ouvrir dans Suisse Notes',
    transcriptReady: 'Votre transcription est prête!',
    transcriptCta: 'Cliquez ci-dessous pour voir votre transcription, résumés et points d\'action',

    // Stop Recording Dialog
    stopRecordingTitle: "Arrêter l'enregistrement?",
    stopRecordingMessage: "Votre enregistrement sera sauvegardé et téléchargé pour la transcription.",
    continueRecording: "Continuer l'enregistrement",
    endRecording: "Terminer l'enregistrement",

    // Success Screen
    clickHereToView: 'Cliquez ici pour voir votre transcription'
  },
  it: {
    // Record Page
    uploadFile: 'Carica file',
    dropHere: 'Trascina il file qui',
    uploadDesc: 'Hai una registrazione esistente? Caricala per la trascrizione.',
    selectFile: 'Seleziona file',
    dragDropHint: 'oppure trascina un file qui',
    recordNew: 'Nuova registrazione',
    microphone: 'Microfono',
    systemAudio: 'Audio di sistema',
    systemAudioDesc: 'Registra tutti i suoni riprodotti sul computer',
    systemAudioEnabled: "L'audio di sistema verrà catturato",
    macPermissionNotice: 'Autorizzazione registrazione schermo richiesta su macOS',

    // Recording states
    readyToRecord: 'Pronto per registrare',
    recordingInProgress: 'Registrazione in corso',
    recordingPaused: 'Registrazione in pausa',
    recordingStopped: 'Registrazione terminata',
    uploading: 'Caricamento...',
    uploadComplete: 'Caricamento completato',
    processing: 'Elaborazione...',

    // Tips
    tipsTitle: 'Consigli per registrazioni migliori',
    tip1: 'Usa un microfono esterno per la migliore qualità audio e differenziazione degli oratori',
    tip2: 'Posiziona il microfono vicino agli oratori',
    tip3: 'La registrazione verrà caricata automaticamente quando ti fermi',
    tipsContact: 'Hai bisogno di aiuto per scegliere un microfono? Contattaci a',

    // Header
    record: 'Registra',
    history: 'Cronologia',
    settings: 'Impostazioni',
    signOut: 'Esci',
    maximize: 'Massimizza finestra',
    restore: 'Ripristina finestra',

    // History
    noRecordings: 'Nessuna registrazione',
    startRecording: 'Inizia la tua prima registrazione',

    // Common
    cancel: 'Annulla',
    confirm: 'Conferma',
    delete: 'Elimina',
    retry: 'Riprova',
    viewHistory: 'Vedi cronologia',
    newRecording: 'Nuova registrazione',
    openInSuisseNotes: 'Apri in Suisse Notes',
    transcriptReady: 'La tua trascrizione è pronta!',
    transcriptCta: 'Clicca sotto per vedere la trascrizione, i riassunti e i punti d\'azione',

    // Stop Recording Dialog
    stopRecordingTitle: 'Terminare la registrazione?',
    stopRecordingMessage: 'La tua registrazione verrà salvata e caricata per la trascrizione.',
    continueRecording: 'Continua registrazione',
    endRecording: 'Termina registrazione',

    // Success Screen
    clickHereToView: 'Clicca qui per vedere la trascrizione'
  }
};

const i18n = createI18n({
  legacy: false,
  locale: 'de',
  fallbackLocale: 'en',
  messages
});

export default ({ app }) => {
  app.use(i18n);
};

export { i18n };
