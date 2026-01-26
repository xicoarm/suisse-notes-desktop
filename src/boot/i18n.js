import { createI18n } from 'vue-i18n';

const messages = {
  en: {
    // Record Page
    uploadFile: 'Upload File',
    dropHere: 'Drop file here',
    uploadDesc: 'Have an existing recording? Upload it for transcription.',
    selectFile: 'Select File',
    dragDropHint: 'or drag & drop a file here',
    tapToSelect: 'Tap to select a file',
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

    // History Page
    historyTitle: 'Recording History',
    historySubtitle: 'View and manage your past recordings',
    noRecordings: 'No recordings yet',
    startRecording: 'Start your first recording',
    statsTotal: 'Total',
    statsUploaded: 'Uploaded',
    statsPending: 'Pending',
    statsFailed: 'Failed',
    loadingRecordings: 'Loading recordings...',
    uploadingNewRecording: 'Uploading new recording...',
    deleteRecordingTitle: 'Delete Recording?',
    deleteRecordingMessage: 'This will remove the recording from your history.',
    deleteFileAlso: 'Also delete the audio file from disk',
    upload: 'Upload',
    retryUpload: 'Retry Upload',
    play: 'Play',
    hide: 'Hide',
    noLocalFile: 'No local file available',
    streamFromServer: 'Stream from server',
    dateToday: 'Today at {time}',
    dateYesterday: 'Yesterday at {time}',
    statusUploading: 'Uploading',
    statusPending: 'Pending',
    statusUploaded: 'Uploaded',
    statusFailed: 'Failed',
    autoDelete: 'Auto-delete',

    // Common
    cancel: 'Cancel',
    confirm: 'Confirm',
    or: 'or',
    delete: 'Delete',
    retry: 'Retry',
    viewHistory: 'View History',
    newRecording: 'New Recording',
    uploadAnother: 'Upload Another',
    cancelUpload: 'Cancel Upload',
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
    stopRecordingFirst: 'Please stop the current recording before switching tabs',

    // File Preview (Upload Page)
    fileSelected: 'File Selected',
    startUpload: 'Start Upload',
    changeFile: 'Change File',

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

    // Legal
    privacyPolicy: 'Privacy Policy',
    termsOfService: 'Terms of Service',
    impressum: 'Impressum',

    // About Page
    aboutHeroSubtitle: 'Intelligent meeting transcription with AI-powered summaries, action items, and insights. Highest data protection standards, hosted in Switzerland. Optimized for Swiss German and all Swiss dialects.',
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
    aboutStartRecording: 'Start Recording',

    // Login Page
    signInToStart: 'Sign in to start recording',
    email: 'Email',
    password: 'Password',
    emailRequired: 'Email is required',
    passwordRequired: 'Password is required',
    signIn: 'Sign In',
    noAccount: "Don't have an account?",
    createAccount: 'Create Account',
    forgotPassword: 'Forgot Password?',
    appDescription: 'Recording app for Suisse Notes platform',
    // Register page
    backToLogin: 'Back to Login',
    createYourAccount: 'Create your account',
    alreadyHaveAccount: 'Already have an account?',
    fullName: 'Full Name',
    nameRequired: 'Name is required',
    passwordMinLength: 'Password must be at least 8 characters'
  },
  de: {
    // Record Page
    uploadFile: 'Datei hochladen',
    dropHere: 'Datei hier ablegen',
    uploadDesc: 'Haben Sie eine bestehende Aufnahme? Laden Sie sie zur Transkription hoch.',
    selectFile: 'Datei auswählen',
    dragDropHint: 'oder Datei hierher ziehen',
    tapToSelect: 'Tippen um Datei auszuwählen',
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

    // History Page
    historyTitle: 'Aufnahmeverlauf',
    historySubtitle: 'Frühere Aufnahmen anzeigen und verwalten',
    noRecordings: 'Noch keine Aufnahmen',
    startRecording: 'Starten Sie Ihre erste Aufnahme',
    statsTotal: 'Gesamt',
    statsUploaded: 'Hochgeladen',
    statsPending: 'Ausstehend',
    statsFailed: 'Fehlgeschlagen',
    loadingRecordings: 'Aufnahmen werden geladen...',
    uploadingNewRecording: 'Neue Aufnahme wird hochgeladen...',
    deleteRecordingTitle: 'Aufnahme löschen?',
    deleteRecordingMessage: 'Die Aufnahme wird aus dem Verlauf entfernt.',
    deleteFileAlso: 'Audiodatei auch von der Festplatte löschen',
    upload: 'Hochladen',
    retryUpload: 'Erneut hochladen',
    play: 'Abspielen',
    hide: 'Ausblenden',
    noLocalFile: 'Keine lokale Datei verfügbar',
    streamFromServer: 'Vom Server streamen',
    dateToday: 'Heute um {time}',
    dateYesterday: 'Gestern um {time}',
    statusUploading: 'Wird hochgeladen',
    statusPending: 'Ausstehend',
    statusUploaded: 'Hochgeladen',
    statusFailed: 'Fehlgeschlagen',
    autoDelete: 'Auto-Löschen',

    // Common
    cancel: 'Abbrechen',
    confirm: 'Bestätigen',
    or: 'oder',
    delete: 'Löschen',
    retry: 'Erneut versuchen',
    viewHistory: 'Verlauf anzeigen',
    newRecording: 'Neue Aufnahme',
    uploadAnother: 'Weitere Datei hochladen',
    cancelUpload: 'Upload abbrechen',
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
    stopRecordingFirst: 'Bitte stoppen Sie die aktuelle Aufnahme, bevor Sie den Tab wechseln',

    // File Preview (Upload Page)
    fileSelected: 'Datei ausgewählt',
    startUpload: 'Upload starten',
    changeFile: 'Datei ändern',

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

    // Legal
    privacyPolicy: 'Datenschutz',
    termsOfService: 'AGB',
    impressum: 'Impressum',

    // About Page
    aboutHeroSubtitle: 'Intelligente Meeting-Transkription mit KI-gestützten Zusammenfassungen, Aktionspunkten und Erkenntnissen. Höchste Datenschutzstandards, gehostet in der Schweiz. Optimiert für Schweizerdeutsch und alle Schweizer Dialekte.',
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
    aboutStartRecording: 'Aufnahme starten',

    // Login Page
    signInToStart: 'Anmelden, um die Aufnahme zu starten',
    email: 'E-Mail',
    password: 'Passwort',
    emailRequired: 'E-Mail ist erforderlich',
    passwordRequired: 'Passwort ist erforderlich',
    signIn: 'Anmelden',
    noAccount: 'Noch kein Konto?',
    createAccount: 'Konto erstellen',
    forgotPassword: 'Passwort vergessen?',
    appDescription: 'Aufnahme-App für die Suisse Notes Plattform',
    // Register page
    backToLogin: 'Zurück zur Anmeldung',
    createYourAccount: 'Erstellen Sie Ihr Konto',
    alreadyHaveAccount: 'Bereits ein Konto?',
    fullName: 'Vollständiger Name',
    nameRequired: 'Name ist erforderlich',
    passwordMinLength: 'Passwort muss mindestens 8 Zeichen lang sein'
  },
  fr: {
    // Record Page
    uploadFile: 'Télécharger un fichier',
    dropHere: 'Déposez le fichier ici',
    uploadDesc: 'Vous avez un enregistrement existant? Téléchargez-le pour la transcription.',
    selectFile: 'Sélectionner un fichier',
    dragDropHint: 'ou glissez-déposez un fichier ici',
    tapToSelect: 'Appuyez pour sélectionner',
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

    // History Page
    historyTitle: 'Historique des enregistrements',
    historySubtitle: 'Afficher et gérer vos enregistrements passés',
    noRecordings: "Pas encore d'enregistrements",
    startRecording: 'Commencez votre premier enregistrement',
    statsTotal: 'Total',
    statsUploaded: 'Téléchargés',
    statsPending: 'En attente',
    statsFailed: 'Échoués',
    loadingRecordings: 'Chargement des enregistrements...',
    uploadingNewRecording: 'Téléchargement du nouvel enregistrement...',
    deleteRecordingTitle: "Supprimer l'enregistrement?",
    deleteRecordingMessage: "L'enregistrement sera supprimé de l'historique.",
    deleteFileAlso: 'Supprimer également le fichier audio du disque',
    upload: 'Télécharger',
    retryUpload: 'Réessayer le téléchargement',
    play: 'Lire',
    hide: 'Masquer',
    noLocalFile: 'Aucun fichier local disponible',
    streamFromServer: 'Diffuser depuis le serveur',
    dateToday: "Aujourd'hui à {time}",
    dateYesterday: 'Hier à {time}',
    statusUploading: 'Téléchargement',
    statusPending: 'En attente',
    statusUploaded: 'Téléchargé',
    statusFailed: 'Échoué',
    autoDelete: 'Suppression auto',

    // Common
    cancel: 'Annuler',
    confirm: 'Confirmer',
    or: 'ou',
    delete: 'Supprimer',
    retry: 'Réessayer',
    viewHistory: "Voir l'historique",
    newRecording: 'Nouvel enregistrement',
    uploadAnother: 'Télécharger un autre fichier',
    cancelUpload: 'Annuler le téléchargement',
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
    stopRecordingFirst: "Veuillez arrêter l'enregistrement en cours avant de changer d'onglet",

    // File Preview (Upload Page)
    fileSelected: 'Fichier sélectionné',
    startUpload: 'Démarrer le téléchargement',
    changeFile: 'Changer de fichier',

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

    // Legal
    privacyPolicy: 'Confidentialité',
    termsOfService: 'CGV',
    impressum: 'Mentions légales',

    // About Page
    aboutHeroSubtitle: 'Transcription intelligente de réunions avec résumés, points d\'action et insights alimentés par l\'IA. Normes de protection des données les plus élevées, hébergé en Suisse. Optimisé pour le suisse allemand et tous les dialectes suisses.',
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
    aboutStartRecording: 'Démarrer l\'enregistrement',

    // Login Page
    signInToStart: 'Connectez-vous pour commencer l\'enregistrement',
    email: 'Email',
    password: 'Mot de passe',
    emailRequired: 'L\'email est requis',
    passwordRequired: 'Le mot de passe est requis',
    signIn: 'Se connecter',
    noAccount: 'Pas encore de compte?',
    createAccount: 'Créer un compte',
    forgotPassword: 'Mot de passe oublié?',
    appDescription: 'Application d\'enregistrement pour la plateforme Suisse Notes',
    // Register page
    backToLogin: 'Retour à la connexion',
    createYourAccount: 'Créez votre compte',
    alreadyHaveAccount: 'Vous avez déjà un compte?',
    fullName: 'Nom complet',
    nameRequired: 'Le nom est requis',
    passwordMinLength: 'Le mot de passe doit contenir au moins 8 caractères'
  },
  it: {
    // Record Page
    uploadFile: 'Carica file',
    dropHere: 'Trascina il file qui',
    uploadDesc: 'Hai una registrazione esistente? Caricala per la trascrizione.',
    selectFile: 'Seleziona file',
    dragDropHint: 'oppure trascina un file qui',
    tapToSelect: 'Tocca per selezionare',
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

    // History Page
    historyTitle: 'Cronologia registrazioni',
    historySubtitle: 'Visualizza e gestisci le tue registrazioni passate',
    noRecordings: 'Nessuna registrazione',
    startRecording: 'Inizia la tua prima registrazione',
    statsTotal: 'Totale',
    statsUploaded: 'Caricati',
    statsPending: 'In attesa',
    statsFailed: 'Falliti',
    loadingRecordings: 'Caricamento registrazioni...',
    uploadingNewRecording: 'Caricamento nuova registrazione...',
    deleteRecordingTitle: 'Eliminare la registrazione?',
    deleteRecordingMessage: 'La registrazione verrà rimossa dalla cronologia.',
    deleteFileAlso: 'Elimina anche il file audio dal disco',
    upload: 'Carica',
    retryUpload: 'Riprova caricamento',
    play: 'Riproduci',
    hide: 'Nascondi',
    noLocalFile: 'Nessun file locale disponibile',
    streamFromServer: 'Riproduci dal server',
    dateToday: 'Oggi alle {time}',
    dateYesterday: 'Ieri alle {time}',
    statusUploading: 'Caricamento',
    statusPending: 'In attesa',
    statusUploaded: 'Caricato',
    statusFailed: 'Fallito',
    autoDelete: 'Auto-elimina',

    // Common
    cancel: 'Annulla',
    confirm: 'Conferma',
    or: 'oppure',
    delete: 'Elimina',
    retry: 'Riprova',
    viewHistory: 'Vedi cronologia',
    newRecording: 'Nuova registrazione',
    uploadAnother: 'Carica un altro file',
    cancelUpload: 'Annulla caricamento',
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
    stopRecordingFirst: 'Ferma la registrazione corrente prima di cambiare scheda',

    // File Preview (Upload Page)
    fileSelected: 'File selezionato',
    startUpload: 'Avvia caricamento',
    changeFile: 'Cambia file',

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

    // Legal
    privacyPolicy: 'Privacy',
    termsOfService: 'Termini di servizio',
    impressum: 'Impressum',

    // About Page
    aboutHeroSubtitle: 'Trascrizione intelligente delle riunioni con riassunti, azioni e insight basati sull\'IA. Standard di protezione dati più elevati, ospitato in Svizzera. Ottimizzato per lo svizzero tedesco e tutti i dialetti svizzeri.',
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
    aboutStartRecording: 'Inizia Registrazione',

    // Login Page
    signInToStart: 'Accedi per iniziare a registrare',
    email: 'Email',
    password: 'Password',
    emailRequired: 'L\'email è obbligatoria',
    passwordRequired: 'La password è obbligatoria',
    signIn: 'Accedi',
    noAccount: 'Non hai un account?',
    createAccount: 'Crea account',
    forgotPassword: 'Password dimenticata?',
    appDescription: 'App di registrazione per la piattaforma Suisse Notes',
    // Register page
    backToLogin: 'Torna al login',
    createYourAccount: 'Crea il tuo account',
    alreadyHaveAccount: 'Hai già un account?',
    fullName: 'Nome completo',
    nameRequired: 'Il nome è obbligatorio',
    passwordMinLength: 'La password deve contenere almeno 8 caratteri'
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
