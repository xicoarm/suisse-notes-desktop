# Logo Backup - Current Implementations

## 1. Header Logo (MainLayout.vue)

### Template:
```html
<div class="logo-icon">
  <q-icon name="mic" size="18px" />
</div>
<span class="logo-text">Suisse Notes</span>
```

### Styles:
```scss
.brand-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 6px 10px;
  margin: -6px -10px;
  border-radius: 10px;
  transition: background 0.2s ease;

  &:hover {
    background: rgba(99, 102, 241, 0.08);
  }

  .logo-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
  }

  .logo-text {
    font-weight: 600;
    font-size: 15px;
    color: #1e293b;
    letter-spacing: -0.3px;
  }
}
```

---

## 2. Landing Page Hero Logo (AboutPage.vue)

### Template:
```html
<div class="hero-icon">
  <q-icon name="record_voice_over" size="64px" color="primary" />
</div>
<h1 class="hero-title">Suisse Notes</h1>
```

### Styles:
```scss
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
```

---

## Color Reference
- Primary Indigo: #6366F1
- Secondary Purple: #8B5CF6
- Text Dark: #1e293b
