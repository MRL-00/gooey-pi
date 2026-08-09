import { useEffect, useState, type CSSProperties } from 'react'
import type { PetDefinition, PrimeWorkApi } from '@/types/api'

export type PetActivity = 'idle' | 'running-left' | 'running-right' | 'speaking' | 'working' | 'waiting' | 'jumping' | 'failed'

const ANIMATIONS: Record<PetActivity, { row: number; frames: number; frameMs: number }> = {
  idle: { row: 0, frames: 6, frameMs: 260 },
  'running-right': { row: 1, frames: 8, frameMs: 85 },
  'running-left': { row: 2, frames: 8, frameMs: 85 },
  speaking: { row: 3, frames: 4, frameMs: 145 },
  jumping: { row: 4, frames: 5, frameMs: 125 },
  failed: { row: 5, frames: 8, frameMs: 180 },
  working: { row: 6, frames: 6, frameMs: 170 },
  waiting: { row: 7, frames: 6, frameMs: 220 },
}

function SpritesheetPet({ dataUrl, activity, size, reduceMotion }: { dataUrl: string; activity: PetActivity; size: number; reduceMotion: boolean }) {
  const animation = ANIMATIONS[activity]
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setFrame(0)
    if (reduceMotion || animation.frames <= 1) return
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % animation.frames), animation.frameMs)
    return () => window.clearInterval(timer)
  }, [activity, animation.frameMs, animation.frames, reduceMotion])
  const height = Math.round(size * 208 / 192)
  return (
    <span className="pet-sprite" style={{ width: size, height } as CSSProperties} aria-hidden="true">
      <img
        src={dataUrl}
        alt=""
        draggable={false}
        style={{
          width: size * 8,
          height: height * 9,
          transform: `translate(${-frame * size}px, ${-animation.row * height}px)`,
        }}
      />
    </span>
  )
}

function OrbPet({ activity, size, reduceMotion }: { activity: PetActivity; size: number; reduceMotion: boolean }) {
  return (
    <span className={`pet-orb pet-orb--${activity}${reduceMotion ? ' is-reduced-motion' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

export function PetAvatar({ pet, pets, activity = 'idle', size = 92, reduceMotion = false }: {
  pet: PetDefinition
  pets: PrimeWorkApi['pets'] | null
  activity?: PetActivity
  size?: number
  reduceMotion?: boolean
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setDataUrl(null)
    if (pet.kind !== 'spritesheet' || !pets) return () => { active = false }
    void pets.sprite(pet.id).then((value) => { if (active) setDataUrl(value) }).catch(() => { if (active) setDataUrl(null) })
    return () => { active = false }
  }, [pet.id, pet.kind, pets])
  if (pet.kind === 'orb') return <OrbPet activity={activity} size={size} reduceMotion={reduceMotion} />
  if (dataUrl) return <SpritesheetPet dataUrl={dataUrl} activity={activity} size={size} reduceMotion={reduceMotion} />
  return <span className="pet-placeholder" style={{ width: size, height: Math.round(size * 208 / 192) }} aria-hidden="true" />
}
