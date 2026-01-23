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
    home: 'Home',
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
    or: 'or',
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
    clickHereToView: 'Click here to view your transcript',
    copyLink: 'Copy Link',
    copyLinkHint: 'Copy link to share with others',
    transcriptUrlLabel: 'Transcript URL',

    // Mode Tab Switcher
    recordAudio: 'Record',
    uploadFileTab: 'Upload File',

    // Transcription Options
    transcriptionOptions: 'Transcription Options',
    transcriptTitle: 'Transcript Title',
    transcriptTitleHint: 'Optional name for this recording',
    customSpellingWords: 'Custom Spelling Words',
    customSpellingHint: 'Add names, acronyms, or technical terms for better accuracy',
    globalVocabulary: 'Global Custom Vocabulary',
    globalVocabularyDesc: 'Words used for all recordings and uploads',
    addWord: 'Add word',
    removeWord: 'Remove',

    // About Page
    aboutHeroSubtitle: 'Intelligent meeting transcription with AI-powered summaries, action items, and insights. Optimized for Swiss German and all Swiss dialects.',
    aboutFeaturesTitle: 'What Suisse Notes Can Do',
    aboutFeatureSwissTitle: 'Swiss German Support',
    aboutFeatureSwissDesc: 'Industry-leading accuracy for all Swiss dialects alongside High German, French, Italian, and English.',
    aboutFeaturePlatformTitle: 'Multi-Platform',
    aboutFeaturePlatformDesc: 'Works with Microsoft Teams, Zoom, Google Meet, and Webex. Record any meeting automatically.',
    aboutFeatureAITitle: 'AI Summaries',
    aboutFeatureAIDesc: 'Get instant meeting summaries, key takeaways, and important decisions extracted automatically.',
    aboutFeatureSpeakerTitle: 'Speaker Recognition',
    aboutFeatureSpeakerDesc: 'Advanced speaker diarization identifies who said what with high accuracy.',
    aboutFeatureSecurityTitle: 'Swiss Security',
    aboutFeatureSecurityDesc: 'GDPR and nDSG compliant. Your data stays in Switzerland with enterprise-grade encryption.',
    aboutFeatureActionsTitle: 'Action Items',
    aboutFeatureActionsDesc: 'Automatically extract action items and decisions from your meetings.',
    aboutIntegrationsTitle: 'Works With Your Tools',
    aboutIntegrationsDesc: 'Seamlessly integrates with all major video conferencing platforms.',
    connectCalendarBtn: 'Automate Your Meetings',
    connectCalendarHint: 'Connect your calendar and let our bot join & transcribe automatically',
    aboutMadeInSwitzerland: 'Made in Switzerland',
    aboutCompanyDesc: 'We are a Swiss AI company focused on building intelligent business tools with privacy and security at the core.',
    aboutGetStarted: 'Get Started',
    aboutStartRecording: 'Start Recording'
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
    home: 'Start',
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
    or: 'oder',
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
    clickHereToView: 'Hier klicken um Ihr Transkript anzuzeigen',
    copyLink: 'Link kopieren',
    copyLinkHint: 'Link zum Teilen kopieren',
    transcriptUrlLabel: 'Transkript-URL',

    // Mode Tab Switcher
    recordAudio: 'Aufnehmen',
    uploadFileTab: 'Datei hochladen',

    // Transcription Options
    transcriptionOptions: 'Transkriptionsoptionen',
    transcriptTitle: 'Transkript-Titel',
    transcriptTitleHint: 'Optionaler Name für diese Aufnahme',
    customSpellingWords: 'Benutzerdefinierte Schreibweisen',
    customSpellingHint: 'Namen, Akronyme oder Fachbegriffe für bessere Genauigkeit hinzufügen',
    globalVocabulary: 'Globales Vokabular',
    globalVocabularyDesc: 'Wörter für alle Aufnahmen und Uploads verwenden',
    addWord: 'Wort hinzufügen',
    removeWord: 'Entfernen',

    // About Page
    aboutHeroSubtitle: 'Intelligente Meeting-Transkription mit KI-gestützten Zusammenfassungen, Aktionspunkten und Erkenntnissen. Optimiert für Schweizerdeutsch und alle Schweizer Dialekte.',
    aboutFeaturesTitle: 'Was Suisse Notes kann',
    aboutFeatureSwissTitle: 'Schweizerdeutsch',
    aboutFeatureSwissDesc: 'Branchenführende Genauigkeit für alle Schweizer Dialekte sowie Hochdeutsch, Französisch, Italienisch und Englisch.',
    aboutFeaturePlatformTitle: 'Multi-Plattform',
    aboutFeaturePlatformDesc: 'Funktioniert mit Microsoft Teams, Zoom, Google Meet und Webex. Jedes Meeting automatisch aufzeichnen.',
    aboutFeatureAITitle: 'KI-Zusammenfassungen',
    aboutFeatureAIDesc: 'Erhalten Sie sofortige Meeting-Zusammenfassungen, wichtige Erkenntnisse und Entscheidungen automatisch.',
    aboutFeatureSpeakerTitle: 'Sprechererkennung',
    aboutFeatureSpeakerDesc: 'Fortschrittliche Sprechererkennung identifiziert, wer was gesagt hat, mit hoher Genauigkeit.',
    aboutFeatureSecurityTitle: 'Schweizer Sicherheit',
    aboutFeatureSecurityDesc: 'DSGVO- und nDSG-konform. Ihre Daten bleiben in der Schweiz mit Enterprise-Verschlüsselung.',
    aboutFeatureActionsTitle: 'Aktionspunkte',
    aboutFeatureActionsDesc: 'Automatische Extraktion von Aktionspunkten und Entscheidungen aus Ihren Meetings.',
    aboutIntegrationsTitle: 'Funktioniert mit Ihren Tools',
    aboutIntegrationsDesc: 'Nahtlose Integration mit allen wichtigen Videokonferenz-Plattformen.',
    connectCalendarBtn: 'Meetings automatisieren',
    connectCalendarHint: 'Kalender verbinden – der Bot nimmt automatisch teil und transkribiert',
    aboutMadeInSwitzerland: 'Made in Switzerland',
    aboutCompanyDesc: 'Wir sind ein Schweizer KI-Unternehmen, das sich auf die Entwicklung intelligenter Business-Tools mit Datenschutz und Sicherheit im Fokus konzentriert.',
    aboutGetStarted: 'Loslegen',
    aboutStartRecording: 'Aufnahme starten'
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
    home: 'Accueil',
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
    or: 'ou',
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
    clickHereToView: 'Cliquez ici pour voir votre transcription',
    copyLink: 'Copier le lien',
    copyLinkHint: 'Copier le lien pour partager',
    transcriptUrlLabel: 'URL de la transcription',

    // Mode Tab Switcher
    recordAudio: 'Enregistrer',
    uploadFileTab: 'Télécharger un fichier',

    // Transcription Options
    transcriptionOptions: 'Options de transcription',
    transcriptTitle: 'Titre de la transcription',
    transcriptTitleHint: 'Nom optionnel pour cet enregistrement',
    customSpellingWords: 'Orthographe personnalisée',
    customSpellingHint: 'Ajoutez des noms, acronymes ou termes techniques pour une meilleure précision',
    globalVocabulary: 'Vocabulaire global',
    globalVocabularyDesc: 'Mots utilisés pour tous les enregistrements et téléchargements',
    addWord: 'Ajouter un mot',
    removeWord: 'Supprimer',

    // About Page
    aboutHeroSubtitle: 'Transcription intelligente de réunions avec résumés, points d\'action et insights alimentés par l\'IA. Optimisé pour le suisse allemand et tous les dialectes suisses.',
    aboutFeaturesTitle: 'Ce que Suisse Notes peut faire',
    aboutFeatureSwissTitle: 'Suisse Allemand',
    aboutFeatureSwissDesc: 'Précision de pointe pour tous les dialectes suisses ainsi que l\'allemand standard, le français, l\'italien et l\'anglais.',
    aboutFeaturePlatformTitle: 'Multi-Plateforme',
    aboutFeaturePlatformDesc: 'Fonctionne avec Microsoft Teams, Zoom, Google Meet et Webex. Enregistrez automatiquement toute réunion.',
    aboutFeatureAITitle: 'Résumés IA',
    aboutFeatureAIDesc: 'Obtenez instantanément des résumés de réunions, points clés et décisions extraites automatiquement.',
    aboutFeatureSpeakerTitle: 'Reconnaissance des Locuteurs',
    aboutFeatureSpeakerDesc: 'La diarisation avancée identifie qui a dit quoi avec une grande précision.',
    aboutFeatureSecurityTitle: 'Sécurité Suisse',
    aboutFeatureSecurityDesc: 'Conforme RGPD et nDSG. Vos données restent en Suisse avec un chiffrement de niveau entreprise.',
    aboutFeatureActionsTitle: 'Points d\'Action',
    aboutFeatureActionsDesc: 'Extraction automatique des points d\'action et décisions de vos réunions.',
    aboutIntegrationsTitle: 'Compatible avec vos Outils',
    aboutIntegrationsDesc: 'Intégration transparente avec toutes les principales plateformes de visioconférence.',
    connectCalendarBtn: 'Automatiser vos réunions',
    connectCalendarHint: 'Connectez votre agenda et laissez notre bot transcrire vos réunions',
    aboutMadeInSwitzerland: 'Fabriqué en Suisse',
    aboutCompanyDesc: 'Nous sommes une entreprise suisse d\'IA axée sur la création d\'outils métier intelligents avec la confidentialité et la sécurité au cœur.',
    aboutGetStarted: 'Commencer',
    aboutStartRecording: 'Démarrer l\'enregistrement'
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
    home: 'Home',
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
    or: 'oppure',
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
    clickHereToView: 'Clicca qui per vedere la trascrizione',
    copyLink: 'Copia link',
    copyLinkHint: 'Copia il link per condividere',
    transcriptUrlLabel: 'URL della trascrizione',

    // Mode Tab Switcher
    recordAudio: 'Registra',
    uploadFileTab: 'Carica file',

    // Transcription Options
    transcriptionOptions: 'Opzioni di trascrizione',
    transcriptTitle: 'Titolo trascrizione',
    transcriptTitleHint: 'Nome opzionale per questa registrazione',
    customSpellingWords: 'Ortografia personalizzata',
    customSpellingHint: 'Aggiungi nomi, acronimi o termini tecnici per una maggiore precisione',
    globalVocabulary: 'Vocabolario globale',
    globalVocabularyDesc: 'Parole utilizzate per tutte le registrazioni e i caricamenti',
    addWord: 'Aggiungi parola',
    removeWord: 'Rimuovi',

    // About Page
    aboutHeroSubtitle: 'Trascrizione intelligente delle riunioni con riassunti, azioni e insight basati sull\'IA. Ottimizzato per lo svizzero tedesco e tutti i dialetti svizzeri.',
    aboutFeaturesTitle: 'Cosa può fare Suisse Notes',
    aboutFeatureSwissTitle: 'Svizzero Tedesco',
    aboutFeatureSwissDesc: 'Precisione leader del settore per tutti i dialetti svizzeri oltre a tedesco standard, francese, italiano e inglese.',
    aboutFeaturePlatformTitle: 'Multi-Piattaforma',
    aboutFeaturePlatformDesc: 'Funziona con Microsoft Teams, Zoom, Google Meet e Webex. Registra automaticamente qualsiasi riunione.',
    aboutFeatureAITitle: 'Riassunti IA',
    aboutFeatureAIDesc: 'Ottieni istantaneamente riassunti delle riunioni, punti chiave e decisioni estratte automaticamente.',
    aboutFeatureSpeakerTitle: 'Riconoscimento Relatori',
    aboutFeatureSpeakerDesc: 'La diarizzazione avanzata identifica chi ha detto cosa con alta precisione.',
    aboutFeatureSecurityTitle: 'Sicurezza Svizzera',
    aboutFeatureSecurityDesc: 'Conforme GDPR e nDSG. I tuoi dati rimangono in Svizzera con crittografia enterprise.',
    aboutFeatureActionsTitle: 'Azioni',
    aboutFeatureActionsDesc: 'Estrazione automatica di azioni e decisioni dalle tue riunioni.',
    aboutIntegrationsTitle: 'Funziona con i Tuoi Strumenti',
    aboutIntegrationsDesc: 'Integrazione perfetta con tutte le principali piattaforme di videoconferenza.',
    connectCalendarBtn: 'Automatizza le riunioni',
    connectCalendarHint: 'Collega il calendario e lascia che il bot trascriva automaticamente',
    aboutMadeInSwitzerland: 'Made in Switzerland',
    aboutCompanyDesc: 'Siamo un\'azienda svizzera di IA focalizzata sulla creazione di strumenti business intelligenti con privacy e sicurezza al centro.',
    aboutGetStarted: 'Inizia',
    aboutStartRecording: 'Inizia Registrazione'
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
