import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';
import {io, Socket} from 'socket.io-client'
import { useTranslation } from 'react-i18next';
import LanguageSelector from './components/LanguageSelector';
import './i18n';

interface Language {
  lang_code: string;
  lang_name: string;
  url: string;
  need_voice_id?: boolean;
  flag_url?: string;
}

interface Voice {
  _id: string;
  voice_id: string;
  gender: string;
  language: string;
  name: string;
  preview: string;
  thumbnailUrl: string;
  flag_url: string;
  language_code: string;
  age?: string[];
  style?: string[];
  scenario?: string[];
}

const App: React.FC = () => {
  const [authMethod, setAuthMethod] = useState<'apiKey' | 'credentials'>('apiKey'); // Auth method selection
  const [apiKey, setApiKey] = useState<string>(''); // API Key for direct API calls
  const [apiKeyInput, setApiKeyInput] = useState<string>(''); // API Key input field
  const [bearerToken, setBearerToken] = useState<string>(''); // Bearer token from credentials
  const [clientId, setClientId] = useState<string>(''); // Client ID for credentials
  const [clientSecret, setClientSecret] = useState<string>(''); // Client Secret for credentials
  const [isTokenLoading, setIsTokenLoading] = useState<boolean>(false); // Loading state for token generation
  const [languages, setLanguages] = useState<Language[]>([]); // Fetched languages
  const [sourceLanguage, setSourceLanguage] = useState<string | null>(null); // Source Language selection
  const [targetLanguages, setTargetLanguages] = useState<string[]>([]); // Target Languages selection (multiple)
  const [selectedVoices, setSelectedVoices] = useState<{ [langCode: string]: string }>({}); // Selected voice IDs mapped by language code
  const [availableVoices, setAvailableVoices] = useState<{ [langCode: string]: Voice[] }>({}); // Voices available for each language
  const [videoUrl, setVideoUrl] = useState<string>(''); // URL for translation
  const [lipSync, setLipSync] = useState<boolean>(true); // Lip sync checkbox (enabled by default)
  const [speakerNum, setSpeakerNum] = useState<number>(0); // Number of speakers (0 = auto-detect, 1-10)
  const [removeBgm, setRemoveBgm] = useState<boolean>(false); // Remove background music
  const [captionType, setCaptionType] = useState<number>(0); // Caption type (0-4)
  const [dynamicDuration, setDynamicDuration] = useState<boolean>(false); // Dynamic video length
  const [captionUrl, setCaptionUrl] = useState<string>(''); // Caption file URL (SRT/ASS)
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false); // Advanced settings visibility
  const [videoPreviewError, setVideoPreviewError] = useState<string | null>(null); // Video preview error
  const [error, setError] = useState<string | null>(null); // Error state
  const [fetchingLanguages, setFetchingLanguages] = useState<boolean>(false); // Loader for language fetch
  const [isTranslating, setIsTranslating] = useState<boolean>(false); // Loader for translation process
  const [translationResult, setTranslationResult] = useState<string | React.ReactNode | null>(null);
  const languageListingUrl = '/api/open/v3/language/list'; // Language API URL (proxied through Vite)
  const voicesUrl = '/api/open/v4/voice/videoTranslation'; // Voices API URL (proxied through Vite)
  const socket = useRef<Socket>();
  const [processingVideos, setProcessingVideos] = useState<{ [langCode: string]: string }>({}); // Map of language code to video URL
  const [videoModelIds, setVideoModelIds] = useState<{ [langCode: string]: string }>({}); // Map of language code to model ID
  const [videoStatuses, setVideoStatuses] = useState<{ [langCode: string]: number }>({}); // Map of language code to status
  const [videoProgress, setVideoProgress] = useState<{ [langCode: string]: number }>({}); // Map of language code to progress
  const [overallProgress, setOverallProgress] = useState<number>(0);
  const [selectedVideoLangCode, setSelectedVideoLangCode] = useState<string | null>(null); // Selected video for full preview
  const [showProcessingPopup, setShowProcessingPopup] = useState<boolean>(false);
  const [showErrorPopup, setShowErrorPopup] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [pollingInterval, setPollingInterval] = useState<ReturnType<typeof setInterval> | null>(null);
  const { t } = useTranslation();

  // Helper function to get authentication headers
  const getAuthHeaders = () => {
    if (authMethod === 'apiKey' && apiKey) {
      // Use x-api-key header for API key authentication
      return { 'x-api-key': apiKey };
    } else if (authMethod === 'credentials' && bearerToken) {
      return { 'Authorization': `Bearer ${bearerToken}` };
    }
    return {};
  };

  // Check if user is authenticated
  const isAuthenticated = () => {
    return (authMethod === 'apiKey' && apiKey) || (authMethod === 'credentials' && bearerToken);
  };
  


  useEffect(() => {
    socket.current = io('http://localhost:3007');
    socket.current.on("connect", () => {
      console.log("Connected to WebSocket server");
    });
    
    socket.current.on("message", async (msg: any) => {
      if (msg.type === 'event') {
        console.log("GETTING DATA from websocket:::", msg.data);
        
        // Handle status updates with model ID
        // Only process if we have active model IDs (not in reset state)
        if (msg.data._id && msg.data.video_status) {
          // Find which language this model ID belongs to using functional update
          setVideoModelIds(currentModelIds => {
            // Ignore messages if we've reset (no active model IDs)
            if (Object.keys(currentModelIds).length === 0) {
              return currentModelIds;
            }
            
            const langCode = Object.keys(currentModelIds).find(
              key => currentModelIds[key] === msg.data._id
            );
            
            if (langCode) {
              // Update status for this specific language
              setVideoStatuses(prev => {
                const updated = { ...prev, [langCode]: msg.data.video_status };
                
                // Check if all videos are done (completed OR failed)
                const allDone = Object.values(updated).every(status => status === 3 || status === 4);
                
                if (allDone) {
                  setShowProcessingPopup(false);
                  if (pollingInterval) {
                    clearInterval(pollingInterval);
                    setPollingInterval(null);
                  }
                }
                
                return updated;
              });
              
              // Only update progress if not failed (failed videos don't count towards progress)
              if (msg.data.video_status !== 4) {
                setVideoProgress(prev => ({ ...prev, [langCode]: msg.data.progress || 0 }));
              } else {
                // Set failed videos to 0 progress so they don't affect average
                setVideoProgress(prev => ({ ...prev, [langCode]: 0 }));
              }
              
              // If video is completed, update the video URL
              if (msg.data.video_status === 3 && msg.data.url) {
                setProcessingVideos(prev => ({ ...prev, [langCode]: msg.data.url }));
              }
            } else {
              // Fallback: check status for this model ID
              checkVideoStatusForModelId(msg.data._id);
            }
            
            return currentModelIds;
          });
        }

        // Handle completed video URL (legacy support)
        // Only process if we have active model IDs (not in reset state)
        if (msg.data.url && !msg.data._id) {
          setVideoModelIds(currentModelIds => {
            // Only process if we have active translations
            if (Object.keys(currentModelIds).length === 0) {
              return currentModelIds; // Ignore if we've reset
            }
            
            const langCode = msg.data.language_code || msg.data.language;
            if (langCode) {
              setProcessingVideos(prev => ({ ...prev, [langCode]: msg.data.url }));
              setVideoStatuses(prev => ({ ...prev, [langCode]: 3 }));
              setVideoProgress(prev => ({ ...prev, [langCode]: 100 }));
            }
            
            return currentModelIds;
          });
        }
      } else if (msg.type === 'error') {
        setShowProcessingPopup(false);
        setErrorMessage(msg.message);
        setShowErrorPopup(true);
        // Mark all as failed if it's a general error
        setVideoModelIds(currentModelIds => {
          const failedStatuses: { [key: string]: number } = {};
          Object.keys(currentModelIds).forEach(langCode => {
            failedStatuses[langCode] = 4;
          });
          setVideoStatuses(failedStatuses);
          return currentModelIds;
        });
        if (pollingInterval) {
          clearInterval(pollingInterval);
          setPollingInterval(null);
        }
      }
    });

    return () => {
      socket.current?.close();
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    }
  }, [apiKey]);

  useEffect(() => {
    if (isAuthenticated()) {
      setFetchingLanguages(true);
      fetchLanguages();
    }
  }, [apiKey, bearerToken, authMethod]);

  useEffect(() => {
    // Fetch voices for all selected target languages
    const fetchVoicesForLanguages = async () => {
      const voicesMap: { [langCode: string]: Voice[] } = {};
      
      for (const langCode of targetLanguages) {
        const lang = languages.find(l => l.lang_code === langCode);
        if (lang?.need_voice_id) {
          try {
            const response = await axios.get(voicesUrl, {
              headers: getAuthHeaders(),
              params: {
                language_code: langCode,
                page: 1,
                size: 100
              }
            });
            const data = response.data;
            if (data.code === 1000) {
              voicesMap[langCode] = data.data.result || [];
            }
          } catch (err) {
            console.error(`Error fetching voices for ${langCode}:`, err);
            voicesMap[langCode] = [];
          }
        }
      }
      
      setAvailableVoices(voicesMap);
    };

    if (targetLanguages.length > 0 && languages.length > 0) {
      fetchVoicesForLanguages();
    } else {
      setAvailableVoices({});
      setSelectedVoices({});
    }
  }, [targetLanguages, languages, apiKey, bearerToken, authMethod]);

  const fetchLanguages = async () => {
    if (!isAuthenticated()) return;
    
    setError(null);
      setLanguages([]);
      setSourceLanguage(null);
      setTargetLanguages([]);
      setSelectedVoices({});
      setAvailableVoices({});
      setLipSync(true);
    try {
      const response = await axios.get(languageListingUrl, {
        headers: getAuthHeaders(),
      });
      const data = response.data;
      if (data.code === 1000) {
        setLanguages(data.data.lang_list || []);
      } else {
        setError(data.msg || t('errors.fetchError'));
      }
    } catch (err) {
      setError(t('errors.fetchError'));
      console.error(err);
    } finally {
      setFetchingLanguages(false);
    }
  };

  // Helper to add target language
  const addTargetLanguage = (langCode: string) => {
    if (!targetLanguages.includes(langCode)) {
      setTargetLanguages([...targetLanguages, langCode]);
    }
  };

  // Helper to remove target language
  const removeTargetLanguage = (langCode: string) => {
    setTargetLanguages(targetLanguages.filter(lang => lang !== langCode));
    // Remove voice selection for this language
    const newSelectedVoices = { ...selectedVoices };
    delete newSelectedVoices[langCode];
    setSelectedVoices(newSelectedVoices);
  };

  // Helper to set voice for a language
  const setVoiceForLanguage = (langCode: string, voiceId: string) => {
    setSelectedVoices({ ...selectedVoices, [langCode]: voiceId });
  };

  // Check video status for a specific model ID and language
  const checkVideoStatusForModelId = async (modelId: string, langCode?: string) => {
    if (!isAuthenticated() || !modelId) return;
    
    try {
      const response = await axios.get(
        `/api/open/v3/content/video/infobymodelid`,
        {
          headers: getAuthHeaders(),
          params: {
            video_model_id: modelId
          }
        }
      );
      
      if (response.data.code === 1000) {
        // Check if we still have active model IDs (not reset) before processing
        setVideoModelIds(currentModelIds => {
          if (Object.keys(currentModelIds).length === 0) {
            return currentModelIds; // Ignore if reset
          }
          
          // Only process if this model ID is still tracked
          if (!Object.values(currentModelIds).includes(modelId)) {
            return currentModelIds; // Ignore if model ID not in current session
          }
          
          const videoData = response.data.data;
          const detectedLangCode = langCode || videoData.language || 'default';
          
          // Update status and progress for this language
          setVideoStatuses(prev => {
            const updated = { ...prev, [detectedLangCode]: videoData.video_status };
            
            // Check if all videos are done (completed OR failed)
            const allDone = Object.values(updated).every(status => status === 3 || status === 4);
            
            if (allDone) {
              setShowProcessingPopup(false);
              if (pollingInterval) {
                clearInterval(pollingInterval);
                setPollingInterval(null);
              }
            }
            
            return updated;
          });
          
          // Only update progress if not failed (failed videos don't count towards progress)
          if (videoData.video_status !== 4) {
            setVideoProgress(prev => ({ ...prev, [detectedLangCode]: videoData.progress || 0 }));
          } else {
            // Set failed videos to 0 progress so they don't affect average
            setVideoProgress(prev => ({ ...prev, [detectedLangCode]: 0 }));
          }
          
          if (videoData.video_status === 3 && videoData.video) {
            // Completed - update video URL
            setProcessingVideos(prev => ({ ...prev, [detectedLangCode]: videoData.video }));
          } else if (videoData.video_status === 4) {
            // Failed for this specific language
            setErrorMessage(videoData.error_reason || t('errors.translationError'));
            // Don't close popup if other languages are still processing
          }
          
          return currentModelIds;
        });
      }
    } catch (err) {
      console.error('Error checking video status:', err);
    }
  };

  // Check status for all video model IDs
  const checkAllVideoStatuses = async () => {
    // Use functional update to get current state
    setVideoModelIds(currentModelIds => {
      const modelIdEntries = Object.entries(currentModelIds);
      if (modelIdEntries.length === 0) return currentModelIds;
      
      // Check all model IDs in parallel
      Promise.all(
        modelIdEntries.map(([langCode, modelId]) => 
          checkVideoStatusForModelId(modelId, langCode)
        )
      ).then(() => {
        // Calculate overall progress after updates (excluding failed videos)
        setVideoProgress(currentProgress => {
          setVideoStatuses(currentStatuses => {
            // Only count progress for videos that are not failed
            const activeProgressEntries = Object.entries(currentProgress).filter(([langCode]) => {
              return currentStatuses[langCode] !== 4; // Exclude failed videos
            });
            
            if (activeProgressEntries.length > 0) {
              const progressValues = activeProgressEntries.map(([, progress]) => progress);
              const avgProgress = progressValues.reduce((sum, p) => sum + p, 0) / progressValues.length;
              setOverallProgress(Math.round(avgProgress));
            } else {
              // If all failed, set progress to 0
              setOverallProgress(0);
            }
            
            return currentStatuses;
          });
          return currentProgress;
        });
      });
      
      return currentModelIds;
    });
  };

  const handleTranslate = async () => {
    if (!videoUrl || targetLanguages.length === 0) {
      setError(t('errors.invalidInput'));
      return;
    }
    
    // Use "DEFAULT" if sourceLanguage is null or empty (Auto Detect)
    const sourceLang = sourceLanguage || 'DEFAULT';

    // Check if all target languages that require voice selection have voices selected
    for (const langCode of targetLanguages) {
      const targetLang = languages.find(lang => lang.lang_code === langCode);
      if (targetLang?.need_voice_id && !selectedVoices[langCode]) {
        setError(t('errors.voiceRequired'));
        return;
      }
    }
  
    // Store lipSync value in localStorage
    localStorage.setItem('lipSyncSelected', lipSync.toString());
  
    // Build voices_map object
    const voicesMap: { [langCode: string]: { voice_id: string } } = {};
    for (const langCode of targetLanguages) {
      const voiceId = selectedVoices[langCode] || '';
      voicesMap[langCode] = { voice_id: voiceId };
    }
  
    const payload: any = {
      url: videoUrl,
      language: targetLanguages.join(','), // Comma-separated string
      source_language: sourceLang,
      lipsync: lipSync,
      speaker_num: speakerNum,
      remove_bgm: removeBgm,
      caption_type: captionType,
      dynamic_duration: dynamicDuration,
      webhookUrl: "https://dd9f-219-91-134-123.ngrok-free.app/api/webhook",
      voices_map: voicesMap,
    };
    
    // Add caption_url only if provided
    if (captionUrl.trim()) {
      payload.caption_url = captionUrl.trim();
    }
  
    setError(null);
    setIsTranslating(true);
    setShowProcessingPopup(true);
    setOverallProgress(0);
    setProcessingVideos({});
    setVideoModelIds({});
    setVideoStatuses({});
    setVideoProgress({});
  
    try {
      const response = await axios.post(
        '/api/open/v3/content/video/createbytranslate',
        payload,
        {
          headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json',
          },
        }
      );
  
      if (response.data.code === 1000) {
        setTranslationResult(null);
        
        // Handle the new all_results structure
        const allResults = response.data.all_results || [];
        const modelIdsMap: { [langCode: string]: string } = {};
        const initialStatuses: { [langCode: string]: number } = {};
        const initialProgress: { [langCode: string]: number } = {};
        
        // Extract model IDs and language codes from all_results
        allResults.forEach((result: any) => {
          if (result.code === 1000 && result.data) {
            const langCode = result.data.language;
            const modelId = result.data._id;
            if (langCode && modelId) {
              modelIdsMap[langCode] = modelId;
              initialStatuses[langCode] = result.data.video_status || 1;
              initialProgress[langCode] = result.data.progress || 0;
            }
          }
        });
        
        // If all_results is empty, fall back to main data (single language)
        if (Object.keys(modelIdsMap).length === 0 && response.data.data?._id) {
          const langCode = response.data.data.language || targetLanguages[0] || 'default';
          modelIdsMap[langCode] = response.data.data._id;
          initialStatuses[langCode] = response.data.data.video_status || 1;
          initialProgress[langCode] = response.data.data.progress || 0;
        }
        
        // Set up tracking for all languages
        setVideoModelIds(modelIdsMap);
        setVideoStatuses(initialStatuses);
        setVideoProgress(initialProgress);
        
        // Calculate initial overall progress
        const progressValues = Object.values(initialProgress);
        if (progressValues.length > 0) {
          const avgProgress = progressValues.reduce((sum, p) => sum + p, 0) / progressValues.length;
          setOverallProgress(Math.round(avgProgress));
        }
        
        // Start polling for all model IDs
        if (Object.keys(modelIdsMap).length > 0) {
          const interval = setInterval(() => {
            checkAllVideoStatuses();
          }, 3000);
          setPollingInterval(interval);
          
          // Also check immediately
          checkAllVideoStatuses();
        }
      } else {
        setError(response.data.msg || t('errors.translationError'));
        setShowProcessingPopup(false);
      }
    } catch (err: any) {
      setError(err.response?.data?.msg || t('errors.translationError'));
      setShowProcessingPopup(false);
      console.error(err);
    } finally {
      setIsTranslating(false);
    }
  };

  const isTranslateButtonDisabled = () => {
    if (!videoUrl || targetLanguages.length === 0) {
      return true;
    }
    // Check if all target languages that require voice selection have voices selected
    for (const langCode of targetLanguages) {
      const lang = languages.find(l => l.lang_code === langCode);
      if (lang?.need_voice_id && !selectedVoices[langCode]) {
        return true;
      }
    }
    return false;
  };

  const handleErrorPopupClose = () => {
    setShowErrorPopup(false);
    setErrorMessage('');
  };

  const handleDownload = (videoUrl: string, langCode: string) => {
    if (videoUrl) {
      // Get language name for filename
      const lang = languages.find(l => l.lang_code === langCode);
      const langName = lang?.lang_name || langCode;
      
      // Create a temporary link element
      const a = document.createElement('a');
      a.href = videoUrl;
      a.download = `translated-video-${langName}-${Date.now()}.mp4`; // Add language name and timestamp
      
      // This will work because the video is already loaded in the video element
      // and the browser has already validated the CORS policy
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const handleTranslateAnother = () => {
    localStorage.removeItem('lipSyncSelected');
    setVideoUrl('');
    setSourceLanguage(null);
    setTargetLanguages([]);
    setSelectedVoices({});
    setAvailableVoices({});
    setLipSync(false);
    setSpeakerNum(0);
    setRemoveBgm(false);
    setCaptionType(0);
    setDynamicDuration(false);
    setCaptionUrl('');
    setShowAdvancedSettings(false);
    setVideoPreviewError(null);
    setError(null);
    setTranslationResult(null);
    setProcessingVideos({});
    setVideoModelIds({});
    setVideoStatuses({});
    setVideoProgress({});
    setOverallProgress(0);
    setSelectedVideoLangCode(null);
    setShowProcessingPopup(false);
    setShowErrorPopup(false);
    setErrorMessage('');
    setIsTranslating(false);
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
  };

  const fetchToken = async () => {
    if (!clientId || !clientSecret) {
      setError(t('errors.tokenError'));
      return;
    }

    setIsTokenLoading(true);
    setError(null);

    try {
      const response = await axios.post(
        '/api/open/v3/getToken',
        {
          clientId,
          clientSecret
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('Token API Response:', response.data);

      if (response.data.code === 1000) {
        if (response.data.token) {
          setBearerToken(response.data.token);
          console.log('Token successfully set:', response.data.token);
        } else {
          setError('Token not found in response');
          console.error('Token missing from response:', response.data);
        }
      } else {
        setError(response.data.msg || 'Failed to fetch token');
        console.error('API Error:', response.data);
      }
    } catch (err: any) {
      console.error('Full error object:', err);
      
      if (err.response) {
        console.error('Error response:', {
          data: err.response.data,
          status: err.response.status,
          headers: err.response.headers
        });
        setError(`Error: ${err.response.data.msg || 'Server error'}`);
      } else if (err.request) {
        console.error('Error request:', err.request);
        setError('No response received from server');
      } else {
        console.error('Error message:', err.message);
        setError(`Error: ${err.message}`);
      }
    } finally {
      setIsTokenLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <img src="/images/4p6vr8j7vbom4axo7k0 2.png" alt="AI Video Translator Logo" className="logo-img" />
          <h1>{t('appTitle')}</h1>
        </div>
        <LanguageSelector />
      </header>
      <main>
        {!isAuthenticated() && (
          <div className="auth-container">
            <div className="auth-tabs">
              <button 
                className={`auth-tab ${authMethod === 'apiKey' ? 'active' : ''}`}
                onClick={() => setAuthMethod('apiKey')}
              >
                {t('auth.apiKey')}
              </button>
              <button 
                className={`auth-tab ${authMethod === 'credentials' ? 'active' : ''}`}
                onClick={() => setAuthMethod('credentials')}
              >
                {t('auth.clientCredentials')}
              </button>
            </div>

            <div className="auth-content">
              {authMethod === 'apiKey' && (
                <div className="api-key-form">
                  <div className="input-group">
                    <label>{t('auth.apiKey')}</label>
                    <input
                      type="text"
                      placeholder={t('auth.enterApiKey')}
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && apiKeyInput) {
                          setApiKey(apiKeyInput);
                          setFetchingLanguages(true);
                        }
                      }}
                    />
                  </div>
                  <button 
                    onClick={() => {
                      if (apiKeyInput) {
                        setApiKey(apiKeyInput);
                        setFetchingLanguages(true);
                      } else {
                        setError(t('errors.apiKeyError'));
                      }
                    }}
                    className="auth-button"
                    disabled={!apiKeyInput}
                  >
                    {t('buttons.submitApiKey')}
                  </button>
                </div>
              )}

              {authMethod === 'credentials' && (
                <div className="credentials-form">
                  <div className="input-group">
                    <label>{t('auth.clientId')}</label>
                    <input
                      type="text"
                      placeholder={t('auth.enterClientId')}
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </div>
                  <div className="input-group">
                    <label>{t('auth.clientSecret')}</label>
                    <input
                      type="password"
                      placeholder={t('auth.enterClientSecret')}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </div>
                  <button 
                    onClick={fetchToken}
                    disabled={isTokenLoading || !clientId || !clientSecret}
                    className="auth-button"
                  >
                    {isTokenLoading ? (
                      <>
                        <div className="spinner"></div>
                        <span>{t('auth.fetchingToken')}</span>
                      </>
                    ) : (
                      t('auth.getToken')
                    )}
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="error-message">
                <i className="fas fa-exclamation-circle"></i>
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {isAuthenticated() && Object.keys(processingVideos).length === 0 && (
          <div className="main-content">
            {fetchingLanguages ? (
              <div className="loader-container">
                <div className="loader"></div>
                <p>{t('loading.languages')}</p>
              </div>
            ) : (
              <div className="translation-workspace-horizontal">
                {/* Left Section - Inputs */}
                <div className="inputs-section">
                  {/* Video URL Input */}
                  <div className="input-card">
                    <div className="card-header">
                      <label>{t('videoUrl')}</label>
                    </div>
                    <input
                      type="url"
                      value={videoUrl}
                      onChange={(e) => {
                        setVideoUrl(e.target.value);
                        setVideoPreviewError(null);
                      }}
                      placeholder={t('enterVideoUrl')}
                      className="modern-input"
                    />
                  </div>

                  {/* Language Selection */}
                  <div className="language-selection-card">
                    <div className="card-header">
                      <h3>{t('languageSelection.title')}</h3>
                    </div>
                    <div className="language-selector-grid">
                      <div className="select-card">
                        <label className="select-label">
                          {t('selectSourceLanguage')}
                        </label>
                        <select
                          value={sourceLanguage || 'DEFAULT'}
                          onChange={(e) => setSourceLanguage(e.target.value === 'DEFAULT' ? null : e.target.value)}
                          className="modern-select"
                        >
                          <option value="DEFAULT">Auto Detect</option>
                          {languages.map((language: Language) => (
                            <option key={language.lang_code} value={language.lang_code}>
                              {language.lang_name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="arrow-icon">→</div>

                      <div className="select-card">
                        <label className="select-label">
                          {t('selectTargetLanguage')} *
                        </label>
                        <div className="multi-select-container">
                          <div className="multi-select-tags">
                            {targetLanguages.map((langCode) => {
                              const lang = languages.find(l => l.lang_code === langCode);
                              return (
                                <div key={langCode} className="language-tag">
                                  <span>{lang?.lang_name || langCode}</span>
                                  <button
                                    type="button"
                                    className="tag-remove"
                                    onClick={() => removeTargetLanguage(langCode)}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                            <select
                              value=""
                              onChange={(e) => {
                                if (e.target.value) {
                                  addTargetLanguage(e.target.value);
                                  e.target.value = '';
                                }
                              }}
                              className="multi-select-dropdown"
                            >
                              <option value="">{t('selectTargetLanguage')}</option>
                              {(() => {
                                const availableLangs = languages.filter(lang => !targetLanguages.includes(lang.lang_code));
                                const withVoice = availableLangs.filter(lang => lang.need_voice_id);
                                const withoutVoice = availableLangs.filter(lang => !lang.need_voice_id);
                                
                                return (
                                  <>
                                    {withoutVoice.length > 0 && (
                                      <>
                                        <option value="" disabled className="section-header">Default Languages</option>
                                        {withoutVoice.map((language: Language) => (
                                          <option key={language.lang_code} value={language.lang_code}>
                                            {language.lang_name}
                                          </option>
                                        ))}
                                      </>
                                    )}
                                    {withVoice.length > 0 && (
                                      <>
                                        <option value="" disabled className="section-header">Languages with voice clone</option>
                                        {withVoice.map((language: Language) => (
                                          <option key={language.lang_code} value={language.lang_code}>
                                            {language.lang_name}
                                          </option>
                                        ))}
                                      </>
                                    )}
                                  </>
                                );
                              })()}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Voice Selection for each target language */}
                  {targetLanguages.map((langCode) => {
                    const lang = languages.find(l => l.lang_code === langCode);
                    if (!lang?.need_voice_id) return null;
                    
                    const voices = availableVoices[langCode] || [];
                    const selectedVoice = selectedVoices[langCode];
                    
                    return (
                      <div key={langCode} className="voice-selection-card">
                        <div className="card-header">
                          <h3>{t('selectVoice')} - {lang.lang_name}</h3>
                        </div>
                        {voices.length === 0 ? (
                          <div className="loader-container-small">
                            <div className="loader-small"></div>
                            <p>{t('loading.voices')}</p>
                          </div>
                        ) : (
                          <div className="voice-grid">
                            {voices.map((voice: Voice) => (
                              <div
                                key={voice.voice_id}
                                className={`voice-card ${selectedVoice === voice.voice_id ? 'selected' : ''}`}
                                onClick={() => setVoiceForLanguage(langCode, voice.voice_id)}
                              >
                                {voice.thumbnailUrl && (
                                  <img src={voice.thumbnailUrl} alt={voice.name} className="voice-thumbnail" />
                                )}
                                <div className="voice-info">
                                  <h4>{voice.name}</h4>
                                  <p className="voice-gender">{voice.gender}</p>
                                  {voice.preview && (
                                    <audio controls className="voice-preview">
                                      <source src={voice.preview} type="audio/mpeg" />
                                    </audio>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Basic Options */}
                  <div className="options-card">
                    <div className="card-header">
                      <h3>{t('basicOptions.title')}</h3>
                    </div>
                    <div className="options-grid">
                      <div className="option-toggle">
                        <label className="toggle-label">
                          <input
                            type="checkbox"
                            checked={lipSync}
                            onChange={(e) => setLipSync(e.target.checked)}
                            className="toggle-checkbox"
                          />
                          <span className="toggle-slider"></span>
                          <span className="toggle-text">
                            {t('enableLipSync')}
                          </span>
                        </label>
                      </div>
                      <div className="option-toggle">
                        <label className="toggle-label">
                          <input
                            type="checkbox"
                            checked={dynamicDuration}
                            onChange={(e) => setDynamicDuration(e.target.checked)}
                            className="toggle-checkbox"
                          />
                          <span className="toggle-slider"></span>
                          <span className="toggle-text">
                            {t('basicOptions.dynamicVideoLength')}
                          </span>
                        </label>
                      </div>
                      <div className="option-select">
                        <label className="select-label">
                          {t('basicOptions.speakerNum')}
                        </label>
                        <select
                          value={speakerNum}
                          onChange={(e) => setSpeakerNum(Number(e.target.value))}
                          className="modern-select"
                        >
                          <option value="0">{t('basicOptions.autoDetect')}</option>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                            <option key={num} value={num}>{num}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Advanced Settings */}
                  <div className="advanced-settings-card">
                    <button
                      className="advanced-toggle"
                      onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                    >
                      <span>{t('advancedSettings.title')}</span>
                      <span className={`toggle-arrow ${showAdvancedSettings ? 'open' : ''}`}>▼</span>
                    </button>
                    {showAdvancedSettings && (
                      <div className="advanced-content">
                        <div className="advanced-option">
                          <label className="toggle-label">
                            <input
                              type="checkbox"
                              checked={removeBgm}
                              onChange={(e) => setRemoveBgm(e.target.checked)}
                              className="toggle-checkbox"
                            />
                            <span className="toggle-slider"></span>
                            <span className="toggle-text">
                              {t('advancedSettings.removeBgm')}
                            </span>
                          </label>
                        </div>
                        <div className="advanced-option">
                          <label className="select-label">
                            {t('advancedSettings.captionType')}
                          </label>
                          <select
                            value={captionType}
                            onChange={(e) => setCaptionType(Number(e.target.value))}
                            className="modern-select"
                          >
                            <option value="0">{t('advancedSettings.captionOptions.none')}</option>
                            <option value="1">{t('advancedSettings.captionOptions.addOriginal')}</option>
                            <option value="2">{t('advancedSettings.captionOptions.addTarget')}</option>
                            <option value="3">{t('advancedSettings.captionOptions.translateReplace')}</option>
                            <option value="4">{t('advancedSettings.captionOptions.addTranslated')}</option>
                          </select>
                        </div>
                        <div className="advanced-option">
                          <label className="select-label">
                            {t('advancedSettings.captionFileUrl')}
                          </label>
                          <input
                            type="url"
                            value={captionUrl}
                            onChange={(e) => setCaptionUrl(e.target.value)}
                            placeholder="https://example.com/captions.srt"
                            className="modern-input"
                          />
                          <small className="input-hint">{t('advancedSettings.captionFileUrlHint')}</small>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Translate Button */}
                  <div className="action-section">
                    <button
                      onClick={handleTranslate}
                      disabled={isTranslateButtonDisabled() || isTranslating}
                      className="translate-btn-primary"
                    >
                      {isTranslating ? (
                        <>
                          <div className="spinner-small"></div>
                          <span>{t('translating')}</span>
                        </>
                      ) : (
                        <>
                          <span>{t('translate')}</span>
                        </>
                      )}
                    </button>
                  </div>

                  {error && <div className="error-message">{error}</div>}
                  {translationResult}
                </div>

                {/* Right Section - Video Preview */}
                <div className="video-section">
                  <div className="video-preview-section">
                    <div className="section-header">
                      <h2>
                        {t('videoPreview.title')}
                      </h2>
                    </div>
                    <div className="video-preview-container">
                      {videoUrl ? (
                        <>
                          <video
                            src={videoUrl}
                            controls
                            className="source-video-preview"
                            onError={() => setVideoPreviewError(t('videoPreview.error'))}
                            onLoadStart={() => setVideoPreviewError(null)}
                          />
                          {videoPreviewError && (
                            <div className="video-preview-error">{videoPreviewError}</div>
                          )}
                        </>
                      ) : (
                        <div className="video-placeholder">
                          <p>{t('videoPreview.placeholder')}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {Object.keys(processingVideos).length > 0 && (
          <div className="result-container animate-fade-in">
            {(() => {
              // Only show single video view if:
              // 1. User explicitly selected a video from gallery, OR
              // 2. There's exactly one video AND we're not in batch mode (check if we have multiple model IDs tracked)
              const isBatchMode = Object.keys(videoModelIds).length > 1;
              const hasSingleVideo = Object.keys(processingVideos).length === 1;
              const shouldShowSingleView = selectedVideoLangCode || (!isBatchMode && hasSingleVideo && !selectedVideoLangCode);
              return shouldShowSingleView;
            })() ? (
              // Single video view or selected video from gallery
              (() => {
                const langCode = selectedVideoLangCode || Object.keys(processingVideos)[0];
                const videoUrl = processingVideos[langCode];
                const lang = languages.find(l => l.lang_code === langCode);
                const langName = lang?.lang_name || langCode;
                const flagUrl = lang?.flag_url;
                
                return (
                  <>
                    <div className="results-header">
                      <h2 className="results-title">{t('results.title')}</h2>
                      <p className="results-subtitle">
                        {t('results.singleVideo')}
                      </p>
                    </div>
                    
                    {Object.keys(processingVideos).length > 1 && (
                      <button 
                        className="back-to-gallery-btn"
                        onClick={() => setSelectedVideoLangCode(null)}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M19 12H5M12 19l-7-7 7-7"/>
                        </svg>
                        {t('results.backToGallery')}
                      </button>
                    )}
                    
                    <div className="single-video-view">
                      <div className="single-video-card">
                        <div className="single-video-header">
                          <div className="single-video-title-group">
                            {flagUrl && (
                              <img src={flagUrl} alt={langName} className="single-video-flag" />
                            )}
                            <div className="single-video-title-content">
                              <h3 className="single-video-title">{langName}</h3>
                              <span className="single-video-lang-code">{langCode.toUpperCase()}</span>
                            </div>
                          </div>
                        </div>
                        
                        <div className="single-video-player">
                          <video 
                            src={videoUrl} 
                            controls 
                            className="single-video-element"
                          />
                        </div>
                        
                        <div className="single-video-actions">
                          <button 
                            className="single-video-download-btn"
                            onClick={() => handleDownload(videoUrl, langCode)}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                              <polyline points="7 10 12 15 17 10"></polyline>
                              <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                            {t('downloadVideo')}
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    <div className="results-footer-actions">
                      <button 
                        className="action-btn translate-another-btn"
                        onClick={handleTranslateAnother}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                          <path d="M21 3v5h-5"></path>
                          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                          <path d="M3 21v-5h5"></path>
                        </svg>
                        {t('translateAnother')}
                      </button>
                    </div>
                  </>
                );
              })()
            ) : (
              // Gallery view for multiple videos
              <>
                <div className="results-header">
                  <h2 className="results-title">{t('results.title')}</h2>
                  <p className="results-subtitle">
                    {(() => {
                      const completedCount = Object.keys(processingVideos).length;
                      // Count total videos excluding failed ones
                      const totalCount = Object.values(videoStatuses).filter(status => status !== 4).length || targetLanguages.length;
                      const failedCount = Object.values(videoStatuses).filter(status => status === 4).length;
                      const activeCount = totalCount - failedCount;
                      
                      if (totalCount > 1 && completedCount < activeCount) {
                        return t('results.videosReady', { completed: completedCount, total: activeCount }) + (failedCount > 0 ? ` (${failedCount} ${t('processing.statuses.failed')})` : '');
                      }
                      if (failedCount > 0 && completedCount > 0) {
                        return t('results.videosReadyWithFailed', { completed: completedCount, failed: failedCount });
                      }
                      return t('results.multipleVideos', { count: completedCount });
                    })()}
                  </p>
                  <p className="results-gallery-hint">{t('results.galleryHint')}</p>
                </div>
                
                <div className="videos-gallery">
                  {Object.entries(processingVideos).map(([langCode, videoUrl]) => {
                    const lang = languages.find(l => l.lang_code === langCode);
                    const langName = lang?.lang_name || langCode;
                    const flagUrl = lang?.flag_url;
                    
                    return (
                      <div 
                        key={langCode} 
                        className="video-gallery-item"
                        onClick={() => setSelectedVideoLangCode(langCode)}
                      >
                        <div className="gallery-item-thumbnail">
                          <video 
                            src={videoUrl}
                            muted
                            className="gallery-video-thumbnail"
                            onMouseEnter={(e) => e.currentTarget.play()}
                            onMouseLeave={(e) => {
                              e.currentTarget.pause();
                              e.currentTarget.currentTime = 0;
                            }}
                          />
                          <div className="gallery-item-overlay">
                            <div className="gallery-play-icon">
                              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                              </svg>
                            </div>
                          </div>
                        </div>
                        
                        <div className="gallery-item-info">
                          <div className="gallery-item-title-group">
                            {flagUrl && (
                              <img src={flagUrl} alt={langName} className="gallery-item-flag" />
                            )}
                            <div className="gallery-item-title-content">
                              <h4 className="gallery-item-title">{langName}</h4>
                              <span className="gallery-item-lang-code">{langCode.toUpperCase()}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                
                <div className="results-footer-actions">
                  <button 
                    className="action-btn translate-another-btn"
                    onClick={handleTranslateAnother}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                      <path d="M21 3v5h-5"></path>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                      <path d="M3 21v-5h5"></path>
                    </svg>
                    {t('translateAnother')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {showProcessingPopup && (
          <div className="processing-popup-overlay">
            <div className="processing-popup">
              <h3>{t('processing.title')}</h3>
              <p>{t('processing.message')}</p>
              <div className="loader"></div>
              {overallProgress > 0 && (
                <div className="progress-container">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${overallProgress}%` }}></div>
                  </div>
                  <span className="progress-text">{overallProgress}%</span>
                </div>
              )}
              {Object.keys(videoStatuses).length > 1 && (
                <div className="language-progress-list">
                  {Object.entries(videoStatuses).map(([langCode, status]) => {
                    const lang = languages.find(l => l.lang_code === langCode);
                    const langName = lang?.lang_name || langCode;
                    const progress = videoProgress[langCode] || 0;
                    const statusText = status === 1 ? t('processing.statuses.queueing') : status === 2 ? t('processing.statuses.processing') : status === 3 ? t('processing.statuses.completed') : t('processing.statuses.failed');
                    
                    return (
                      <div key={langCode} className="language-progress-item">
                        <div className="language-progress-header">
                          <span className="language-progress-name">{langName}</span>
                          <span className={`language-progress-status status-${status}`}>{statusText}</span>
                        </div>
                        {status !== 3 && status !== 4 && (
                          <div className="language-progress-bar">
                            <div className="language-progress-fill" style={{ width: `${progress}%` }}></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {showErrorPopup && (
          <div className="processing-popup-overlay">
            <div className="processing-popup error">
              <p>{errorMessage}</p>
              <button onClick={handleErrorPopupClose}>{t('buttons.ok')}</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
